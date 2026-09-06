use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

/// 插件隔离 JSON 存储：%APPDATA%/<identifier>/plugins/<plugin_id>/store.json
/// 每个插件只能读写自己的命名空间，宿主按 plugin_id 落盘。
pub struct StoreState {
    root: Mutex<Option<PathBuf>>, // app_data_dir，setup 时填充
}

impl StoreState {
    pub fn new() -> Self {
        Self { root: Mutex::new(None) }
    }

    pub fn init(&self, app: &AppHandle) {
        let dir = app.path().app_data_dir().expect("app_data_dir unavailable");
        *self.root.lock().unwrap() = Some(dir.join("plugins"));
    }

    fn plugin_file(&self, plugin_id: &str) -> Result<PathBuf, String> {
        if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\')
        {
            return Err("invalid plugin id".into());
        }
        self.root
            .lock().unwrap()
            .clone()
            .ok_or_else(|| "store not initialized".to_string())
            .map(|root| root.join(plugin_id).join("store.json"))
    }

    fn read_map(path: &PathBuf) -> Map<String, Value> {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn write_map(path: &PathBuf, map: &Map<String, Value>) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn store_get(state: tauri::State<StoreState>, plugin_id: String, key: String) -> Result<Option<Value>, String> {
    let path = state.plugin_file(&plugin_id)?;
    Ok(StoreState::read_map(&path).get(&key).cloned())
}

#[tauri::command]
pub fn store_set(state: tauri::State<StoreState>, plugin_id: String, key: String, value: Value) -> Result<(), String> {
    let path = state.plugin_file(&plugin_id)?;
    let mut map = StoreState::read_map(&path);
    map.insert(key, value);
    StoreState::write_map(&path, &map)
}

#[tauri::command]
pub fn store_delete(state: tauri::State<StoreState>, plugin_id: String, key: String) -> Result<(), String> {
    let path = state.plugin_file(&plugin_id)?;
    let mut map = StoreState::read_map(&path);
    map.remove(&key);
    StoreState::write_map(&path, &map)
}
