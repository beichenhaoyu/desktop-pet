use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

/// 插件 id 规则，与前端 `validateManifest` 的 `/^[a-z0-9][a-z0-9.-]{2,63}$/` 保持一致：
/// 首字符字母数字、其后只允许小写字母/数字/点/连字符，总长 3~64。
/// 这条规则同时是 overlay 窗口标签净化的前提 —— id 里不可能出现 `_`，
/// 所以 `.` → `_` 是可逆编码，`a.b` 与 `a-b` 不会被压成同一个标签。
pub fn is_safe_id(plugin_id: &str) -> bool {
    let bytes = plugin_id.as_bytes();
    if !(3..=64).contains(&bytes.len()) {
        return false;
    }
    let head = bytes[0];
    let ok_head = head.is_ascii_lowercase() || head.is_ascii_digit();
    ok_head
        && bytes[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-'))
}

fn read_manifest(dir: &PathBuf, plugin_id: &str) -> Result<Value, String> {
    let path = dir.join(plugin_id).join("manifest.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())
}

/// 扫描 plugins 目录，收集合法插件的 manifest。
/// 目录名必须等于 manifest.id —— 否则插件可冒用他人身份，读写其存储与 widget 路径。
fn collect_manifests(app: &tauri::AppHandle) -> Result<Vec<Value>, String> {
    let dir = plugins_dir(app)?;
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

#[tauri::command]
pub fn plugins_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    collect_manifests(&app)
}

/// 插件文件的修改时间（毫秒）。前端拿它给 `import()` 拼 cache-busting 查询串：
/// 「放进目录即生效」要对代码变更也成立，否则同名 URL 永远命中模块缓存，
/// 覆盖 entry.js 之后非重启 webview 不可。
#[tauri::command]
pub fn plugin_file_version(app: tauri::AppHandle, plugin_id: String, rel: String) -> Result<u64, String> {
    if !is_safe_id(&plugin_id) || !is_safe_rel(&rel) {
        return Err("invalid plugin file".into());
    }
    let path = plugins_dir(&app)?.join(&plugin_id).join(&rel);
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取 {path:?} 失败: {e}"))?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

/// 当前实际安装的插件 id 集合，用于回收已删除插件留下的授权。
pub fn installed_plugin_ids(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(collect_manifests(app)?
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .collect())
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

/// `petplugin://<插件 id>/<相对路径>`：把插件文件从宿主认定的 plugins 目录读给 webview。
/// Windows 上 WebView2 把它映射成 `http://petplugin.localhost/...`。
/// 磁盘位置只有 `plugins_dir()` 一个解析点，因此不必在配置里重复写一遍路径 ——
/// asset 协议 + scope 的方案正是因为 `$CARGO_MANIFEST_DIR` 在 dev 下不展开而 403。
pub fn register_plugin_protocol(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("petplugin", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .filter(|o| is_local_origin(o))
            .map(str::to_string);
        let path = request.uri().path().to_string();
        // 读盘走 blocking 线程池，不与 tokio worker 抢时间；一条请求一条裸线程的话
        // 插件页一刷新就是十几条线程
        tauri::async_runtime::spawn_blocking(move || responder.respond(file_response(&app, &path, origin)));
    })
}

/// 只把 CORS 反射给本地 origin：任何真实外站都不该读到本地插件文件
fn is_local_origin(origin: &str) -> bool {
    tauri::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|h| h == "localhost" || h.ends_with(".localhost")))
        .unwrap_or(false)
}

/// 每一段只允许 [A-Za-z0-9._-] 且不为 . / ..
/// —— 拼出 plugins 目录之外的路径在这一步就没有可能。
fn is_safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

fn content_type(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn file_response(
    app: &tauri::AppHandle,
    url_path: &str,
    origin: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let mut segments = url_path.trim_start_matches('/').splitn(2, '/');
    let plugin_id = segments.next().unwrap_or_default();
    let rel = segments.next().unwrap_or_default();

    let mut body: Option<Vec<u8>> = None;
    if is_safe_id(plugin_id) && is_safe_rel(rel) {
        if let Ok(file) = plugins_dir(app).map(|dir| dir.join(plugin_id).join(rel)) {
            body = std::fs::read(file).ok();
        }
    }

    let found = body.is_some();
    let mut resp = tauri::http::Response::new(body.unwrap_or_default());
    if !found {
        *resp.status_mut() = tauri::http::StatusCode::NOT_FOUND;
    }
    if let Ok(value) = content_type(url_path).parse() {
        resp.headers_mut().insert(tauri::http::header::CONTENT_TYPE, value);
    }
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            resp
                .headers_mut()
                .insert("Access-Control-Allow-Origin", value);
        }
    }
    resp
}

/// 持有 notify watcher。RecommendedWatcher 一旦被 drop 就停止监听，
/// 所以必须由 app state 长期持有，不能只在 setup 里造个局部变量。
/// 只用于持有 watcher（被 drop 即停止监听），字段本身不读
#[allow(dead_code)]
pub struct PluginWatcher(pub notify::RecommendedWatcher);

/// 监听 plugins 目录变化，去抖后广播 `host:plugins-changed`，
/// 让宠物窗 reconcile 启停、设置窗/悬浮窗刷新列表。
pub fn spawn_plugins_watcher(app: &tauri::AppHandle) -> Result<PluginWatcher, String> {
    use notify::{EventKind, RecursiveMode, Watcher};

    let dir = plugins_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {e}"))?;

    let sink = app.clone();
    let in_flight = Arc::new(AtomicBool::new(false));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // 只读访问与属性变化不代表插件集合变了
        if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
            return;
        }
        // 一次安装会连发多个事件：600ms 内合并成一次广播
        if in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        let sink = sink.clone();
        let flag = in_flight.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            flag.store(false, Ordering::SeqCst);
            crate::services::permission::prune_orphan_grants(&sink);
            let _ = sink.emit("host:plugins-changed", ());
        });
    })
    .map_err(|e| e.to_string())?;
    // 只监听一层：插件必须是以自身 id 命名的顶层目录（见 collect_manifests 的一致性校验）
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(PluginWatcher(watcher))
}

#[cfg(test)]
mod tests {
    use super::is_safe_id;

    #[test]
    fn accepts_the_same_ids_as_the_frontend_rule() {
        for id in ["todo", "zz.probe", "com.pet.hr-ble", "a1.2-3"] {
            assert!(is_safe_id(id), "{id} 应当合法");
        }
    }

    #[test]
    fn rejects_what_the_frontend_rule_rejects() {
        for id in [
            "",           // 空
            "ab",         // 太短（{2,63} 加首字符至少 3）
            "Todo",       // 大写
            "a_b",        // 下划线留给 overlay 标签做转义，不能出现在 id 里
            "../etc",     // 路径穿越
            "a/b",        // 分隔符
            r"a\b",
            "a b",        // 空格
            "a:b",        // 窗口标签里合法，但不在 id 词表内
        ] {
            assert!(!is_safe_id(id), "{id} 应当被拒");
        }
    }
}
