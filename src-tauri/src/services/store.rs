use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::fsutil::write_atomic;

/// 插件隔离 JSON 存储：%APPDATA%/<identifier>/plugins/<plugin_id>/store.json
/// 每个插件只能读写自己的命名空间，宿主按 plugin_id 落盘。
pub struct StoreState {
    root: Mutex<Option<PathBuf>>, // app_data_dir，setup 时填充
}

/// 每个插件一份读写锁。store 是「读整份 → 改一个键 → 写回整份」，
/// 设置窗与宠物窗同时写同一个插件时，没有这把锁就是后写覆盖先写、静默丢键。
fn locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

fn plugin_lock(plugin_id: &str) -> Arc<Mutex<()>> {
    let mut map = locks().lock().unwrap_or_else(|p| p.into_inner());
    map.entry(plugin_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

impl StoreState {
    pub fn new() -> Self {
        Self { root: Mutex::new(None) }
    }

    pub fn init(&self, app: &AppHandle) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        *self.root.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir.join("plugins"));
        Ok(())
    }

    fn plugin_file(&self, plugin_id: &str) -> Result<PathBuf, String> {
        if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\')
        {
            return Err("invalid plugin id".into());
        }
        self.root
            .lock().unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| "store not initialized".to_string())
            .map(|root| root.join(plugin_id).join("store.json"))
    }

    /// 删除某插件的全部存储（撤销授权时连带清理，不留孤儿数据）
    pub fn clear_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let path = self.plugin_file(plugin_id)?;
        let dir = path.parent().ok_or("无法定位插件存储目录")?;
        match fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 读存储。损坏时返回 Err —— 原先 `.ok()` 把解析失败当成空表，
    /// 下一次 store_set 就会用「只有新键」的内容覆盖整个文件，等于静默丢数据。
    fn read_map(path: &Path) -> Result<Map<String, Value>, String> {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str::<Value>(&raw)
                .map(|v| v.as_object().cloned().unwrap_or_default())
                .map_err(|e| format!("插件存储文件已损坏 {}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(format!("读取插件存储失败 {}: {e}", path.display())),
        }
    }

    /// 原子写：临时文件 + rename（见 fsutil）。
    /// 直接 fs::write 若中途断电会留下半截 JSON，下次读即「为空」，再写就清空该插件全部数据。
    fn write_map(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        write_atomic(path, json.as_bytes())
    }
}

#[tauri::command]
pub fn store_get(state: tauri::State<StoreState>, plugin_id: String, key: String) -> Result<Option<Value>, String> {
    let path = state.plugin_file(&plugin_id)?;
    let lock = plugin_lock(&plugin_id);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    Ok(StoreState::read_map(&path)?.get(&key).cloned())
}

#[tauri::command]
pub fn store_set(state: tauri::State<StoreState>, plugin_id: String, key: String, value: Value) -> Result<(), String> {
    let path = state.plugin_file(&plugin_id)?;
    let lock = plugin_lock(&plugin_id);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = StoreState::read_map(&path)?;
    map.insert(key, value);
    StoreState::write_map(&path, &map)
}

#[tauri::command]
pub fn store_delete(state: tauri::State<StoreState>, plugin_id: String, key: String) -> Result<(), String> {
    let path = state.plugin_file(&plugin_id)?;
    let lock = plugin_lock(&plugin_id);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = StoreState::read_map(&path)?;
    map.remove(&key);
    StoreState::write_map(&path, &map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pet-store-{name}"))
    }

    #[test]
    fn concurrent_writes_keep_both_keys() {
        // 两个「窗口」并发写同一插件的不同键：读-改-写必须串行，两个键都要留下
        let dir = tmp_store(&format!("race-{}", std::process::id()));
        let path = dir.join("store.json");
        let _ = fs::remove_dir_all(&dir);
        let lock = plugin_lock("race");
        let mut handles = Vec::new();
        for key in ["a", "b"] {
            let path = path.clone();
            let lock = lock.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..20 {
                    let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
                    let mut map = StoreState::read_map(&path).unwrap();
                    map.insert(format!("{key}{i}"), Value::from(i));
                    StoreState::write_map(&path, &map).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let map = StoreState::read_map(&path).unwrap();
        assert_eq!(map.len(), 40, "并发写入丢了键：实际 {}", map.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_map() {
        let dir = tmp_store(&format!("bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        fs::write(&path, "这不是合法 JSON").unwrap();
        assert!(StoreState::read_map(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
