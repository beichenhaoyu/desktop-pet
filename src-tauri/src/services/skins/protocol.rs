use std::fs;

use super::local::{skin_dir, skins_root};

/// 协议里只认这三个文件名：目录穿越在这一步就没有可能
const SERVED_FILES: &[&str] = &["sprite.webp", "pet.json", "meta.json"];

/* ================= petskin:// 协议 ================= */

/// `petskin://<slug>/<文件>`：把已下载的形象图集读给 webview。
/// 与插件文件的 petplugin:// 同一条路 —— 磁盘位置只有 skins_root() 一个解析点。
pub fn register_skin_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("petskin", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        // CORS 只反射给本地 origin：任何真实外站都不该读到本地形象文件
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .filter(|o| {
                tauri::Url::parse(o)
                    .ok()
                    .and_then(|u| {
                        u.host_str()
                            .map(|h| h == "localhost" || h.ends_with(".localhost"))
                    })
                    .unwrap_or(false)
            })
            .map(str::to_string);
        let path = request.uri().path().to_string();
        tauri::async_runtime::spawn_blocking(move || {
            responder.respond(skin_response(&app, &path, origin))
        });
    })
}

fn skin_response(
    app: &tauri::AppHandle,
    url_path: &str,
    origin: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let mut segments = url_path.trim_start_matches('/').splitn(2, '/');
    let slug = segments.next().unwrap_or_default();
    let file = segments.next().unwrap_or_default();

    let mut body: Option<Vec<u8>> = None;
    // 文件名白名单 + skin_dir 的 slug 校验，两层都过才去磁盘上拼路径
    if SERVED_FILES.contains(&file) {
        if let Ok(root) = skins_root(app) {
            if let Ok(dir) = skin_dir(&root, slug) {
                body = fs::read(dir.join(file)).ok();
            }
        }
    }

    // 图集可达 12 MB：状态先定下来再移动 body，不必为拼响应整份克隆
    let found = body.is_some();
    let mut resp = tauri::http::Response::new(body.unwrap_or_default());
    if !found {
        *resp.status_mut() = tauri::http::StatusCode::NOT_FOUND;
    }
    // rsplit_once('.') 给出 (前段, 扩展名)，要匹配的是第二段
    let ctype = match file.rsplit_once('.') {
        Some((_, "webp")) => "image/webp",
        Some((_, "json")) => "application/json",
        _ => "application/octet-stream",
    };
    if let Ok(value) = ctype.parse() {
        resp.headers_mut()
            .insert(tauri::http::header::CONTENT_TYPE, value);
    }
    // 图集要能被 canvas 读像素（回归与后续截图都用得上），同本地 origin 才给
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            resp.headers_mut()
                .insert("Access-Control-Allow-Origin", value);
        }
    }
    resp
}
