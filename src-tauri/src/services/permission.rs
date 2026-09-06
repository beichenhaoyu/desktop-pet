use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

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

    pub fn init(&self, app: &AppHandle) {
        let dir = app.path().app_data_dir().expect("app_data_dir unavailable");
        let file = dir.join("authorizations.json");
        if let Ok(s) = fs::read_to_string(&file) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, Vec<String>>>(&s) {
                *self.granted.lock().unwrap() = map;
            }
        }
        *self.file.lock().unwrap() = Some(file);
    }

    fn save(&self) {
        if let Some(file) = self.file.lock().unwrap().clone() {
            if let Some(parent) = file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&*self.granted.lock().unwrap()) {
                let _ = fs::write(&file, json);
            }
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

    pub fn list(&self) -> HashMap<String, Vec<String>> {
        self.granted.lock().unwrap().clone()
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
}

/// 检查单个能力是否已授权
#[tauri::command]
pub fn permission_check(state: tauri::State<PermissionState>, plugin_id: String, capability: String) -> bool {
    valid_id(&plugin_id) && state.is_granted(&plugin_id, &capability)
}

/// 请求授权：已全部授权则立即放行；否则弹同意框阻塞等待用户决定（60s 超时视为拒绝）
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

/// 同意框页面拉取详情
#[tauri::command]
pub fn consent_details(state: tauri::State<PermissionState>, req_id: String) -> Result<ConsentDetails, String> {
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
pub fn consent_answer(state: tauri::State<PermissionState>, req_id: String, granted: bool) -> Result<(), String> {
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

/// 设置窗：撤销某插件的全部授权
#[tauri::command]
pub fn permission_revoke(state: tauri::State<PermissionState>, plugin_id: String) -> Vec<String> {
    if valid_id(&plugin_id) {
        state.revoke_all(&plugin_id)
    } else {
        Vec::new()
    }
}
