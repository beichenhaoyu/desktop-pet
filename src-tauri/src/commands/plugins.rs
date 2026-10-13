use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::ids::is_safe_id;

/// manifest 字段约束的唯一数据源（K4）：与 TS 侧 import 的是同一份磁盘文件
/// （`src/runtime/plugin-runtime.ts` 读它、`webview` 与这里都不许自带副本）。
/// 编译期内嵌，打包版无需把 schema 放进 bundle.resources。
const MANIFEST_SCHEMA_JSON: &str = include_str!("../../../packages/sdk/manifest.schema.json");

/// 首次访问时解析内嵌 schema（编译期文件，解析只做一次）。
fn manifest_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(MANIFEST_SCHEMA_JSON).expect("manifest.schema.json 不是合法 JSON")
    })
}

/// 按 manifest.schema.json 校验 manifest 的字段约束（K4）：
/// 必填键清单、id 的长度上下限（字符集部分仍归 `ids::is_safe_id` —— 唯一实现，S4）、
/// permissions 的元素类型与成员资格（`plugin_caps::is_known`）。
/// 拒绝发生在扫描阶段：坏 manifest 不进列表，只经 `host:plugin-error` 上报。
fn validate_manifest_fields(manifest: &Value) -> Result<(), String> {
    let schema = manifest_schema();
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .ok_or("manifest.schema.json 缺 required")?;
    for key in required {
        let key = key
            .as_str()
            .ok_or("manifest.schema.json 的 required 项必须是字符串")?;
        if manifest.get(key).is_none() {
            return Err(format!("manifest 缺少 {key}"));
        }
    }
    let id_rule = schema
        .get("properties")
        .and_then(|p| p.get("id"))
        .ok_or("manifest.schema.json 缺 properties.id")?;
    let id_min = id_rule
        .get("minLength")
        .and_then(Value::as_u64)
        .ok_or("manifest.schema.json 缺 id.minLength")?;
    let id_max = id_rule
        .get("maxLength")
        .and_then(Value::as_u64)
        .ok_or("manifest.schema.json 缺 id.maxLength")?;
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .ok_or("manifest 缺少 id")?;
    if !(id_min..=id_max).contains(&(id.chars().count() as u64)) || !is_safe_id(id) {
        return Err(format!("非法插件 id: {id}"));
    }
    if let Some(value) = manifest.get("permissions") {
        let arr = value.as_array().ok_or("permissions 必须是数组")?;
        for item in arr {
            // 以前这里对非字符串元素 filter_map 静默丢弃：
            // 「声明了但类型写错」的能力等于没声明，现场只剩「未在 manifest 声明这些能力」，
            // 看不出真正原因（K4 修复）。
            let name = item
                .as_str()
                .ok_or_else(|| format!("permissions 元素必须是字符串: {item}"))?;
            if !crate::plugin_caps::is_known(name) {
                return Err(format!("未知能力名: {name}"));
            }
        }
    }
    Ok(())
}

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

// 插件 id 的规则只在 `crate::ids::is_safe_id` 有一份实现（S4）——
// 它同时是存储目录名、overlay 窗口标签与授权表键的来源，各处的口径必须一致。

fn read_manifest(dir: &Path, plugin_id: &str) -> Result<Value, String> {
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
            validate_manifest_fields(&v)?;
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
pub fn plugin_file_version(
    app: tauri::AppHandle,
    plugin_id: String,
    rel: String,
) -> Result<u64, String> {
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
/// 非字符串元素与不在名单里的名字都是明确错误，不再静默丢弃（K4）。
pub fn declared_capabilities(
    app: &tauri::AppHandle,
    plugin_id: &str,
) -> Result<Vec<String>, String> {
    if !is_safe_id(plugin_id) {
        return Err("invalid plugin id".into());
    }
    let manifest = read_manifest(&plugins_dir(app)?, plugin_id)?;
    let Some(value) = manifest.get("permissions") else {
        return Ok(Vec::new());
    };
    let arr = value.as_array().ok_or("permissions 必须是数组")?;
    let mut declared = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .as_str()
            .ok_or_else(|| format!("permissions 元素必须是字符串: {item}"))?;
        if !crate::plugin_caps::is_known(name) {
            return Err(format!("未知能力名: {name}"));
        }
        declared.push(name.to_string());
    }
    Ok(declared)
}

/// `petplugin://<插件 id>/<相对路径>`：把插件文件从宿主认定的 plugins 目录读给 webview。
/// Windows 上 WebView2 把它映射成 `http://petplugin.localhost/...`。
/// 磁盘位置只有 `plugins_dir()` 一个解析点，因此不必在配置里重复写一遍路径 ——
/// asset 协议 + scope 的方案正是因为 `$CARGO_MANIFEST_DIR` 在 dev 下不展开而 403。
pub fn register_plugin_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
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
        tauri::async_runtime::spawn_blocking(move || {
            responder.respond(file_response(&app, &path, origin))
        });
    })
}

/// 只把 CORS 反射给本地 origin：任何真实外站都不该读到本地插件文件
fn is_local_origin(origin: &str) -> bool {
    tauri::Url::parse(origin)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h == "localhost" || h.ends_with(".localhost"))
        })
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
        resp.headers_mut()
            .insert(tauri::http::header::CONTENT_TYPE, value);
    }
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            resp.headers_mut()
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
    use super::*;

    /// S4：id 规则只剩 `crate::ids::is_safe_id` 一份。这里钉住「本模块确实引用的是那一份」，
    /// 免得日后又在这个文件里长出第二套手写检查。
    /// 只看 `#[cfg(test)]` 之前的代码，否则断言里那些字面量会自我命中。
    #[test]
    fn plugins_module_uses_the_single_id_validator() {
        let full = include_str!("plugins.rs");
        let code = full.split("#[cfg(test)]").next().unwrap_or(full);
        assert!(
            code.contains("use crate::ids::is_safe_id;"),
            "plugins.rs 没有引用统一实现"
        );
        for banned in ["pub fn is_safe_id(", "fn valid_id(", "contains(\"..\")"] {
            assert!(
                !code.contains(banned),
                "plugins.rs 里出现了第二份 id 检查: {banned}"
            );
        }
    }

    /// K4：schema 的 id 约束（模式串 + 长度上下限）必须与 `ids.rs` 的词表是同一件事 ——
    /// 改 schema 里 pattern/minLength/maxLength 任一处，这里即红（负向自证用的就是这条）。
    #[test]
    fn schema_id_bounds_match_the_ids_vocab() {
        let id_rule = &manifest_schema()["properties"]["id"];
        assert_eq!(
            id_rule["pattern"], "^[a-z0-9][a-z0-9.-]{2,63}$",
            "schema 的 id 模式串变了 —— 它必须逐字照抄既有前端正则"
        );
        let min = id_rule["minLength"]
            .as_u64()
            .expect("schema 缺 id.minLength");
        let max = id_rule["maxLength"]
            .as_u64()
            .expect("schema 缺 id.maxLength");
        assert_eq!(
            (min, max),
            (3, 64),
            "schema 的 id 长度上下限与模式串 {{2,63}} 的展开不一致"
        );
        for len in [2u64, 3, 64, 65] {
            let id = "a".repeat(len as usize);
            let schema_ok = (min..=max).contains(&len);
            assert_eq!(
                schema_ok,
                is_safe_id(&id),
                "长度 {len} 处 schema 与 ids.rs 的判定不一致"
            );
        }
    }

    /// K4：`validate_manifest_fields` 按 schema 拒绝 —— 缺必填键、坏 id、坏 permissions。
    #[test]
    fn manifest_fields_are_validated_against_the_schema() {
        let good = || {
            serde_json::json!({
                "id": "zz.good",
                "name": "好插件",
                "version": "0.0.1",
                "entry": "index.js",
                "permissions": ["storage"]
            })
        };
        assert!(
            validate_manifest_fields(&good()).is_ok(),
            "合法 manifest 被拒"
        );

        for key in ["id", "name", "version", "entry"] {
            let mut m = good();
            m.as_object_mut().unwrap().remove(key);
            let err = validate_manifest_fields(&m).unwrap_err();
            assert!(err.contains(key), "缺 {key} 的报错没带键名: {err}");
        }

        let mut m = good();
        m["id"] = serde_json::json!("Todo");
        assert!(validate_manifest_fields(&m)
            .unwrap_err()
            .contains("非法插件 id"));
        let mut m = good();
        m["id"] = serde_json::json!("a".repeat(64));
        assert!(
            validate_manifest_fields(&m).is_ok(),
            "64 字符 id 应当合法（上限边界）"
        );
        let mut m = good();
        m["id"] = serde_json::json!("a".repeat(65));
        assert!(validate_manifest_fields(&m).is_err(), "65 字符 id 应当被拒");

        let mut m = good();
        m["permissions"] = serde_json::json!(["storage", 42]);
        let err = validate_manifest_fields(&m).unwrap_err();
        assert!(
            err.contains("必须是字符串") && err.contains("42"),
            "非字符串元素的报错: {err}"
        );
        let mut m = good();
        m["permissions"] = serde_json::json!(["not-a-cap"]);
        let err = validate_manifest_fields(&m).unwrap_err();
        assert!(
            err.contains("未知能力名") && err.contains("not-a-cap"),
            "未在名单里的能力名报错: {err}"
        );
        let mut m = good();
        m["permissions"] = serde_json::json!("storage");
        assert!(
            validate_manifest_fields(&m).is_err(),
            "permissions 非数组应当被拒"
        );
    }

    /// K4：四个在售插件的真 manifest 全部通过新校验 —— 加 apiVersion/minHostVersion
    /// 是扩接口，不改现有插件也必须兼容。
    #[test]
    fn shipped_manifests_pass_the_schema() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("plugins 目录").flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(raw) = std::fs::read_to_string(entry.path().join("manifest.json")) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            // 目录名与 id 的一致归 collect_manifests 判，这里只管字段约束
            if value.get("id").and_then(Value::as_str) != Some(name.as_str()) {
                continue;
            }
            validate_manifest_fields(&value)
                .unwrap_or_else(|e| panic!("{name} 的真 manifest 未通过 schema 校验: {e}"));
            checked += 1;
        }
        assert!(
            checked >= 4,
            "只校验到 {checked} 个真实插件，扫目录的口径大概坏了"
        );
    }
}
