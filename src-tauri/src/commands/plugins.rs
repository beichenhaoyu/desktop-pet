use serde_json::Value;
use tauri::{Emitter, Manager};

/// 扫描 plugins 目录，返回各插件 manifest（JSON）列表。
/// dev 环境读仓库根 plugins/；release 读资源目录 plugins/（打包时由 bundle.resources 复制）。
#[tauri::command]
pub fn plugins_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let dir = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("plugins")
    };

    let mut manifests = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取插件目录失败: {e}"))?;
    for entry in entries.flatten() {
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        match std::fs::read_to_string(&manifest_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
        {
            Ok(v) => manifests.push(v),
            Err(e) => {
                let name = entry.file_name().to_string_lossy().to_string();
                let _ = app.emit(
                    "host:plugin-error",
                    serde_json::json!({ "plugin": name, "error": format!("manifest 无效: {e}") }),
                );
            }
        }
    }
    Ok(manifests)
}
