use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

use super::store::StoreState;
use crate::fsutil::write_atomic;
use crate::ids::is_safe_id;

/// 插件权限管理：授权表持久化 + 首次调用未授权能力时弹同意框。
/// 进程内插件不是硬安全边界，这里是策略层（见 ARCHITECTURE.md 信任模型）。
pub struct PermissionState {
    file: Mutex<Option<PathBuf>>,
    granted: Mutex<HashMap<String, Vec<String>>>,
    pending: Mutex<HashMap<String, PendingConsent>>,
}

struct PendingConsent {
    sender: oneshot::Sender<bool>,
    plugin_id: String,
    plugin_name: String,
    caps: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ConsentDetails {
    pub req_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub caps: Vec<String>,
}

impl PermissionState {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            granted: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn init(&self, app: &AppHandle) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let file = dir.join("authorizations.json");
        if let Some(map) = restore_from(&file) {
            *self.granted.lock().unwrap_or_else(|p| p.into_inner()) = map;
        }
        *self.file.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
        Ok(())
    }

    fn save(&self) {
        let Some(file) = self.file.lock().unwrap_or_else(|p| p.into_inner()).clone() else {
            log::warn!("授权存储尚未初始化，本次授权变更未落盘");
            return;
        };
        if let Some(parent) = file.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!("创建授权目录失败: {e}");
            }
        }
        let json = match serde_json::to_string_pretty(
            &*self.granted.lock().unwrap_or_else(|p| p.into_inner()),
        ) {
            Ok(j) => j,
            Err(e) => {
                log::error!("序列化授权表失败: {e}");
                return;
            }
        };
        // 原子写：半截的 authorizations.json 会让下次启动把所有授权当成空表
        if let Err(e) = write_atomic(&file, json.as_bytes()) {
            log::warn!("授权落盘失败: {e}");
        }
    }

    pub fn is_granted(&self, plugin_id: &str, cap: &str) -> bool {
        self.granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(plugin_id)
            .map(|caps| caps.iter().any(|c| c == cap))
            .unwrap_or(false)
    }

    /// 某插件当前已授权的能力快照。阻塞线程里拿不到 `State`，
    /// 需要在别处逐跳复核域名的话（见 services::http）带这份快照过去。
    pub fn granted_caps(&self, plugin_id: &str) -> Vec<String> {
        self.granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(plugin_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn grant(&self, plugin_id: &str, caps: &[String]) {
        let mut map = self.granted.lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.entry(plugin_id.to_string()).or_default();
        for c in caps {
            if !entry.contains(c) {
                entry.push(c.clone());
            }
        }
        drop(map);
        self.save();
    }

    pub fn revoke_all(&self, plugin_id: &str) -> Vec<String> {
        let revoked = self
            .granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(plugin_id)
            .unwrap_or_default();
        self.save();
        revoked
    }

    /// 丢弃挂起的同意请求：drop sender 后等待方立刻按「拒绝」返回，
    /// 不必空等 60s 超时。同意框被关闭时由 on_window_event 调用。
    pub fn discard_pending(&self, req_id: &str) {
        let dropped = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(req_id);
        if dropped.is_some() {
            log::info!("同意框未作答即关闭，按拒绝处理: {req_id}");
        }
    }

    pub fn list(&self) -> HashMap<String, Vec<String>> {
        self.granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 只保留仍在盘的插件的授权，返回被回收的 id。
    pub fn retain_known(&self, known: &HashSet<String>) -> Vec<String> {
        let gone: Vec<String> = {
            let mut map = self.granted.lock().unwrap_or_else(|p| p.into_inner());
            let gone: Vec<String> = map
                .keys()
                .filter(|id| !known.contains(*id))
                .cloned()
                .collect();
            for id in &gone {
                map.remove(id);
            }
            gone
        };
        if !gone.is_empty() {
            self.save();
        }
        gone
    }
}

// 插件 id 一律用 `crate::ids::is_safe_id`（S4）。
// 这里以前另有一份 `valid_id`（只挡 `..` `/` `\`），比 overlay/store 那两份都松 ——
// 三份各写各的正是一个 id 能穿过某道门、又被另一道挡住的来源。

/// 从落盘的授权表恢复。返回 None 表示「没有文件」或「文件读坏了」——
/// 两种情况本次启动都按空表运行，且绝不覆盖原文件（半截的 authorizations.json 要是
/// 被当成空表写回去，用户给过的所有授权就没了）。
fn restore_from(file: &Path) -> Option<HashMap<String, Vec<String>>> {
    let raw = fs::read_to_string(file).ok()?;
    match serde_json::from_str::<HashMap<String, Vec<String>>>(&raw) {
        Ok(map) => Some(map),
        Err(e) => {
            log::error!("authorizations.json 解析失败，本次启动按空授权表运行: {file:?}: {e}");
            None
        }
    }
}

/// 授权表查询的唯一口径：非法 id 一律视为未授权（挡住冒名与路径式 id）。
pub fn check_capability(state: &PermissionState, plugin_id: &str, capability: &str) -> bool {
    is_safe_id(plugin_id) && state.is_granted(plugin_id, capability)
}

/// 请求里 manifest 没声明的那些能力。唯一放宽是 http：`http:<host>` 视为被 `http` 覆盖。
/// 其余一律精确匹配 —— 别改成前缀匹配，否则声明一个 `ble` 就等于给了 `ble:connect`。
fn undeclared_caps(declared: &[String], requested: &[String]) -> Vec<String> {
    requested
        .iter()
        .filter(|c| {
            !declared.iter().any(|d| {
                d == *c
                    || (d == crate::plugin_caps::HTTP
                        && c.starts_with(crate::plugin_caps::http_host_prefix()))
            })
        })
        .cloned()
        .collect()
}

/// 插件目录变动后回收孤儿授权。
/// 读不到目录时什么都不做 —— 宁可留着过期授权，也不要在一次临时 IO 失败上把用户给过的权限抹掉。
pub fn prune_orphan_grants(app: &AppHandle) {
    let Ok(ids) = crate::commands::plugins::installed_plugin_ids(app) else {
        return;
    };
    let known: HashSet<String> = ids.into_iter().collect();
    let removed = app.state::<PermissionState>().retain_known(&known);
    if !removed.is_empty() {
        log::info!("回收已卸载插件的授权: {}", removed.join(", "));
        // 目录都没了，能力也收走了，它的悬浮层再没人能关（同 permission_revoke 那条理由）
        for id in &removed {
            crate::window::overlay::reclaim_for_permission(app, id);
        }
    }
}

/// 检查单个能力是否已授权
#[tauri::command]
pub fn permission_check(
    state: tauri::State<PermissionState>,
    plugin_id: String,
    capability: String,
) -> bool {
    check_capability(&state, &plugin_id, &capability)
}

/// 请求授权：只受理 manifest 已声明的能力；已全部授权则立即放行；
/// 否则弹同意框阻塞等待用户决定（60s 超时视为拒绝）
#[tauri::command]
pub async fn permission_request(
    app: AppHandle,
    state: tauri::State<'_, PermissionState>,
    plugin_id: String,
    plugin_name: String,
    capabilities: Vec<String>,
) -> Result<bool, String> {
    if !is_safe_id(&plugin_id) {
        return Err("invalid plugin id".into());
    }
    let declared = crate::commands::plugins::declared_capabilities(&app, &plugin_id)?;
    ensure_declared(&plugin_id, &declared, &capabilities)?;
    if capabilities.iter().all(|c| state.is_granted(&plugin_id, c)) {
        return Ok(true);
    }
    ask_user(app, &state, plugin_id, plugin_name, capabilities).await
}

/// 「未声明就不许申请」这条规则单独成函数（ADR-0005）。
/// 磁盘 manifest 是声明能力的唯一事实来源，未声明直接拒绝、不弹框；
/// 例外口径照旧：http:<host> 视为被 http 覆盖，判定收在 undeclared_caps 里。
fn ensure_declared(
    plugin_id: &str,
    declared: &[String],
    requested: &[String],
) -> Result<(), String> {
    let undeclared = undeclared_caps(declared, requested);
    if undeclared.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{} 未在 manifest 声明这些能力: {}",
        plugin_id,
        undeclared.join(", ")
    ))
}

/// 弹同意框并阻塞等答复：登记挂起项、开窗、装关窗看门狗、超时与清理都住在这里，
/// 命令体只留一次委托（ADR-0005）。
async fn ask_user(
    app: AppHandle,
    state: &tauri::State<'_, PermissionState>,
    plugin_id: String,
    plugin_name: String,
    capabilities: Vec<String>,
) -> Result<bool, String> {
    let req_id = format!("r{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel::<bool>();
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            req_id.clone(),
            PendingConsent {
                sender: tx,
                plugin_id: plugin_id.clone(),
                plugin_name: plugin_name.clone(),
                caps: capabilities.clone(),
            },
        );

    let label = format!("consent-{}", req_id);
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("src/consent.html".into()))
        .title("权限确认")
        .inner_size(420.0, 320.0)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .build()
        .map_err(|e| {
            state
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&req_id);
            e.to_string()
        })?;
    let _ = win.set_focus();
    // 用户把同意框直接关掉（Alt+F4 / 托盘退出等）时必须立刻按「拒绝」结束等待，
    // 否则那次插件调用要空等满 60s 超时
    {
        let app_for_close = app.clone();
        let req_for_close = req_id.clone();
        win.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = app_for_close.try_state::<PermissionState>() {
                    state.discard_pending(&req_for_close);
                }
            }
        });
    }

    let answer = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
    // 无论结果如何都清理窗口与挂起项
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    let pending = state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&req_id);
    if consent_outcome(answer.ok().and_then(|r| r.ok())) {
        state.grant(&plugin_id, &capabilities);
        return Ok(true);
    }
    drop(pending);
    Ok(false)
}

/// 同意框的答复只有「明确答了是」才算授权：超时、通道断开、窗口被直接关掉一律按拒绝收口。
fn consent_outcome(answered: Option<bool>) -> bool {
    matches!(answered, Some(true))
}

/// 同意框只能由它自己的窗口应答：req_id 会从窗口 label 泄露，
/// 不绑定调用方的话任何窗口都能自问自答地放行。
fn assert_consent_caller(window: &tauri::Window, req_id: &str) -> Result<(), String> {
    if window.label() == format!("consent-{req_id}") {
        Ok(())
    } else {
        Err("consent window does not own this request".into())
    }
}

/// 同意框页面拉取详情
#[tauri::command]
pub fn consent_details(
    window: tauri::Window,
    state: tauri::State<PermissionState>,
    req_id: String,
) -> Result<ConsentDetails, String> {
    assert_consent_caller(&window, &req_id)?;
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&req_id)
        .map(|p| ConsentDetails {
            req_id: req_id.clone(),
            plugin_id: p.plugin_id.clone(),
            plugin_name: p.plugin_name.clone(),
            caps: p.caps.clone(),
        })
        .ok_or_else(|| "request not found".into())
}

/// 同意框页面回传用户决定
#[tauri::command]
pub fn consent_answer(
    window: tauri::Window,
    state: tauri::State<PermissionState>,
    req_id: String,
    granted: bool,
) -> Result<(), String> {
    assert_consent_caller(&window, &req_id)?;
    let sender = state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&req_id)
        .map(|p| p.sender);
    match sender {
        Some(tx) => tx.send(granted).map_err(|_| "receiver dropped".into()),
        None => Err("request not found".into()),
    }
}

/// 授权表：只认设置窗。插件 JS 就跑在宠物窗里，
/// 不门禁的话任意插件一行 invoke 就能抹掉别人的授权并连带清掉其存储。
#[tauri::command]
pub fn permission_list(
    window: tauri::Window,
    state: tauri::State<PermissionState>,
) -> Result<HashMap<String, Vec<String>>, String> {
    crate::gate::settings(&window, "查看授权表")?;
    Ok(state.list())
}

/// 设置窗：撤销某插件的全部授权，并连带清掉它落盘的存储
#[tauri::command]
pub fn permission_revoke(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: String,
    state: tauri::State<PermissionState>,
    store: tauri::State<StoreState>,
) -> Result<Vec<String>, String> {
    crate::gate::settings(&window, "撤销授权")?;
    if !is_safe_id(&plugin_id) {
        return Err("invalid plugin id".into());
    }
    let revoked = state.revoke_all(&plugin_id);
    if let Err(e) = store.clear_plugin(&plugin_id) {
        log::warn!("清理 {plugin_id} 存储失败: {e}");
    }
    // 能力已经收走了，插件面的 overlay 门禁此后过不去 —— 那扇置顶透明窗必须由宿主先收掉，
    // 否则撤销授权反而留下一张再也没人能关的卡片（信息泄露 + 窗口泄漏）
    crate::window::overlay::reclaim_for_permission(&app, &plugin_id);
    // 前端桥会缓存「这个能力已授权」来省掉逐次 IPC（见 runtime/bridge.ts）。
    // 撤销必须让这份缓存失效，否则已加载的插件还能继续用刚被收回的能力。
    let _ = app.emit("host:permission-revoked", &plugin_id);
    Ok(revoked)
}

#[cfg(test)]
#[path = "permission.tests.rs"]
mod tests;
