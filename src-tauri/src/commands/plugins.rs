use std::path::PathBuf;

use serde_json::Value;
use tauri::{Emitter, Manager};

/// 插件目录根：dev 读仓库根 plugins/；release 读资源目录 plugins/（打包时由 bundle.resources 复制）。
fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"))
    } else {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("plugins"))
            .map_err(|e| e.to_string())
    }
}

fn is_safe_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && !plugin_id.contains("..")
        && !plugin_id.contains('/')
        && !plugin_id.contains('\\')
}

fn read_manifest(dir: &PathBuf, plugin_id: &str) -> Result<Value, String> {
    let path = dir.join(plugin_id).join("manifest.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())
}

/// 扫描 plugins 目录，返回各插件 manifest（JSON）列表。
/// 目录名必须等于 manifest.id —— 否则插件可冒用他人身份，读写其存储与 widget 路径。
#[tauri::command]
pub fn plugins_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let dir = plugins_dir(&app)?;
    let mut manifests = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取插件目录失败: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().join("manifest.json").is_file() {
            continue;
        }
        let loaded = read_manifest(&dir, &name).and_then(|v| {
            match v.get("id").and_then(Value::as_str) {
                Some(id) if id == name => Ok(v),
                Some(id) => Err(format!("manifest.id \"{id}\" 与目录名 \"{name}\" 不一致")),
                None => Err("manifest 缺少 id".to_string()),
            }
        });
        match loaded {
            Ok(v) => manifests.push(v),
            Err(e) => {
                let _ = app.emit(
                    "host:plugin-error",
                    serde_json::json!({ "plugin": name, "error": format!("manifest 无效: {e}") }),
                );
            }
        }
    }
    Ok(manifests)
}

/// manifest 声明的能力列表。以磁盘上的 manifest 为唯一事实来源，
/// 供 permission_request 校验「请求的能力确实声明过」。
pub fn declared_capabilities(app: &tauri::AppHandle, plugin_id: &str) -> Result<Vec<String>, String> {
    if !is_safe_id(plugin_id) {
        return Err("invalid plugin id".into());
    }
    let manifest = read_manifest(&plugins_dir(app)?, plugin_id)?;
    Ok(manifest
        .get("permissions")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}
