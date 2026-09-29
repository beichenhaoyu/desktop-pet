use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

use super::store::StoreState;

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
        if let Ok(s) = fs::read_to_string(&file) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, Vec<String>>>(&s) {
                *self.granted.lock().unwrap() = map;
            } else {
                // 授权表读坏了不能就地覆盖：留着原文件，本次按空表运行并打日志
                log::error!("authorizations.json 解析失败，本次启动按空授权表运行: {file:?}");
            }
        }
        *self.file.lock().unwrap() = Some(file);
        Ok(())
    }

    fn save(&self) {
        let Some(file) = self.file.lock().unwrap().clone() else {
            log::warn!("授权存储尚未初始化，本次授权变更未落盘");
            return;
        };
        if let Some(parent) = file.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!("创建授权目录失败: {e}");
            }
        }
        let json = match serde_json::to_string_pretty(&*self.granted.lock().unwrap()) {
            Ok(j) => j,
            Err(e) => {
                log::error!("序列化授权表失败: {e}");
                return;
            }
        };
        // 原子写：半截的 authorizations.json 会让下次启动把所有授权当成空表
        let tmp = file.with_extension("json.tmp");
        if let Err(e) = fs::write(&tmp, &json).and_then(|()| fs::rename(&tmp, &file)) {
            let _ = fs::remove_file(&tmp);
            log::warn!("授权落盘失败: {e}");
        }
    }

    pub fn is_granted(&self, plugin_id: &str, cap: &str) -> bool {
        self.granted
            .lock().unwrap()
            .get(plugin_id)
            .map(|caps| caps.iter().any(|c| c == cap))
            .unwrap_or(false)
    }

    pub fn grant(&self, plugin_id: &str, caps: &[String]) {
        let mut map = self.granted.lock().unwrap();
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
        let revoked = self.granted.lock().unwrap().remove(plugin_id).unwrap_or_default();
        self.save();
        revoked
    }

    /// 丢弃挂起的同意请求：drop sender 后等待方立刻按「拒绝」返回，
    /// 不必空等 60s 超时。同意框被关闭时由 on_window_event 调用。
    pub fn discard_pending(&self, req_id: &str) {
        let dropped = self.pending.lock().unwrap().remove(req_id);
        if dropped.is_some() {
            log::info!("同意框未作答即关闭，按拒绝处理: {req_id}");
        }
    }

    pub fn list(&self) -> HashMap<String, Vec<String>> {
        self.granted.lock().unwrap().clone()
    }

    /// 只保留仍在盘的插件的授权，返回被回收的 id。
    pub fn retain_known(&self, known: &HashSet<String>) -> Vec<String> {
        let gone: Vec<String> = {
            let mut map = self.granted.lock().unwrap();
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

fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
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
    }
}

/// 检查单个能力是否已授权
#[tauri::command]
pub fn permission_check(state: tauri::State<PermissionState>, plugin_id: String, capability: String) -> bool {
    valid_id(&plugin_id) && state.is_granted(&plugin_id, &capability)
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
    if !valid_id(&plugin_id) {
        return Err("invalid plugin id".into());
    }
    // 磁盘 manifest 是声明能力的唯一事实来源：未声明的能力直接拒绝，不弹框。
    // 例外：http 能力按「插件 × 域名」逐个授权，故 http:<host> 视为被 http 覆盖
    let declared = crate::commands::plugins::declared_capabilities(&app, &plugin_id)?;
    let undeclared: Vec<&str> = capabilities
        .iter()
        .filter(|c| {
            !declared
                .iter()
                .any(|d| d == *c || (d == "http" && c.starts_with("http:")))
        })
        .map(String::as_str)
        .collect();
    if !undeclared.is_empty() {
        return Err(format!(
            "{} 未在 manifest 声明这些能力: {}",
            plugin_id,
            undeclared.join(", ")
        ));
    }
    if capabilities.iter().all(|c| state.is_granted(&plugin_id, c)) {
        return Ok(true);
    }

    let req_id = format!("r{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel::<bool>();
    state.pending.lock().unwrap().insert(
        req_id.clone(),
        PendingConsent { sender: tx, plugin_id: plugin_id.clone(), plugin_name: plugin_name.clone(), caps: capabilities.clone() },
    );

    let label = format!("consent-{}", req_id);
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("consent.html".into()))
        .title("权限确认")
        .inner_size(420.0, 320.0)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .build()
        .map_err(|e| {
            state.pending.lock().unwrap().remove(&req_id);
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
    let pending = state.pending.lock().unwrap().remove(&req_id);
    match answer {
        Ok(Ok(true)) => {
            state.grant(&plugin_id, &capabilities);
            Ok(true)
        }
        _ => {
            drop(pending);
            Ok(false)
        }
    }
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
        .lock().unwrap()
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
    let sender = state.pending.lock().unwrap().remove(&req_id).map(|p| p.sender);
    match sender {
        Some(tx) => tx.send(granted).map_err(|_| "receiver dropped".into()),
        None => Err("request not found".into()),
    }
}

/// 设置窗：列出全部授权
#[tauri::command]
pub fn permission_list(state: tauri::State<PermissionState>) -> HashMap<String, Vec<String>> {
    state.list()
}

/// 设置窗：撤销某插件的全部授权，并连带清掉它落盘的存储
#[tauri::command]
pub fn permission_revoke(
    plugin_id: String,
    state: tauri::State<PermissionState>,
    store: tauri::State<StoreState>,
) -> Vec<String> {
    if !valid_id(&plugin_id) {
        return Vec::new();
    }
    let revoked = state.revoke_all(&plugin_id);
    if let Err(e) = store.clear_plugin(&plugin_id) {
        log::warn!("清理 {plugin_id} 存储失败: {e}");
    }
    revoked
}
