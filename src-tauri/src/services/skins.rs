// Petdex 桌宠形象：名字解析、图集下载、磁盘布局与 petskin:// 协议。
//
// 口径与插件文件同源：仓库不内置任何美术，形象一律由宿主在运行时从 Petdex 公开画廊下载，
// 本项目仅供学习与自娱自乐、不用于商用，也不二次分发这些文件。
// 磁盘位置只有 skins_root() 一个解析点，dev 与打包版走同一条路。
//
// 解析接口是公开的 `https://petdex.dev/api/manifest/v2`（无需鉴权）。它的 `pets` 是**数组的数组**，
// 列顺序由同一响应里的 `fields` 给出 —— 所以下面按字段名取列，不硬编码下标。
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::fsutil::write_atomic;

/// 公开画廊目录（实测 200、约 863 KB、4800+ 条）
pub const MANIFEST_URL: &str = "https://petdex.dev/api/manifest/v2";
/// 默认形象：首次启动且本地什么都没有时装它
pub const DEFAULT_SLUG: &str = "deepseek";

/// 图集只可能来自这几个主机（petdex 自己的 R2 域名，含已废弃但仍可能出现在旧记录里的）
const ASSET_HOSTS: &[&str] = &[
    "assets.petdex.dev",
    "petdex-assets.raillyhugo.workers.dev",
    "pub-94495283df974cfea5e98d6a9e3fa462.r2.dev",
];

const MANIFEST_MAX_BYTES: u64 = 16 << 20; // 目录整份约 1 MB，留足余量
const ATLAS_MAX_BYTES: u64 = 12 << 20; // 实测单张 1.7~2.4 MB（VP8L 无损）
const TIMEOUT: Duration = Duration::from_secs(20);

/// 协议里只认这三个文件名：目录穿越在这一步就没有可能
const SERVED_FILES: &[&str] = &["sprite.webp", "pet.json", "meta.json"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    pub slug: String,
    pub display_name: String,
    pub sprite_version_number: u32,
    pub url: String,
}

#[derive(Serialize, Debug)]
struct Meta {
    slug: String,
    display_name: String,
    sprite_version_number: u32,
    /// 图集来源，便于以后核对版本变化
    asset_url: String,
    installed_at_ms: u64,
}

static AGENT: OnceLock<ureq::Agent> = OnceLock::new();

fn agent() -> &'static ureq::Agent {
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(TIMEOUT)
            .timeout_read(TIMEOUT)
            .timeout_write(TIMEOUT)
            .build()
    })
}

/* ================= 纯函数（可单测） ================= */

/// 用户输入的名字 → slug。petdex 的 slug 只用小写字母、数字与 `-`/`_`；
/// 非法字符一律拒绝而不是清洗掉 —— 静默改写会让「输入 A 装成 B」这种误会无法排查。
pub fn normalize_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() || name.len() > 64 {
        return Err("名字为空或过长".into());
    }
    if !name.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '-' || c == '_'
    }) {
        return Err(format!("名字不合法（只允许字母、数字、- 与 _）: {raw}"));
    }
    Ok(name)
}

pub fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 只接受 https + 白名单主机 + 不含 `..`/绝对路径的相对路径
pub fn asset_url(base: &str, rel: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(base).map_err(|e| format!("assetBase 非法: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("图集只走 https，收到 {}", parsed.scheme()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "assetBase 缺少主机名".to_string())?;
    if !ASSET_HOSTS.contains(&host) {
        return Err(format!("图集主机不在白名单: {host}"));
    }
    if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|s| s == ".." || s == ".") {
        return Err(format!("图集路径不安全: {rel}"));
    }
    Ok(format!("{}/{}", base.trim_end_matches('/'), rel))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PetEntry {
    pub slug: String,
    pub display_name: String,
    pub spritesheet: String,
    pub pet_json: String,
    pub version: u32,
}

/// 从目录里按名字找宠物：精确 slug → 大小写不敏感 slug → 唯一的 displayName 精确匹配。
/// 命中多条 displayName 时不猜，直接把候选报回去。
pub fn pick_pet(manifest: &Value, name: &str) -> Result<PetEntry, String> {
    let fields: Vec<&str> = manifest
        .get("fields")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let col = |key: &str| fields.iter().position(|f| *f == key);
    let (Some(i_slug), Some(i_display), Some(i_sheet)) =
        (col("slug"), col("displayName"), col("spritesheet"))
    else {
        return Err("目录响应缺少 fields 里的 slug/displayName/spritesheet 列".into());
    };
    let i_json = col("petJson");
    let i_ver = col("spriteVersionNumber");
    let want = name.trim().to_ascii_lowercase();

    let rows = manifest
        .get("pets")
        .and_then(Value::as_array)
        .ok_or_else(|| "目录响应里没有 pets 数组".to_string())?;

    let cell = |row: &Value, idx: usize| -> String {
        row.as_array()
            .and_then(|a| a.get(idx))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let entry = |row: &Value| PetEntry {
        slug: cell(row, i_slug),
        display_name: cell(row, i_display),
        spritesheet: cell(row, i_sheet),
        pet_json: i_json.map(|idx| cell(row, idx)).unwrap_or_default(),
        version: i_ver
            .and_then(|idx| row.as_array()?.get(idx)?.as_u64())
            .unwrap_or(1) as u32,
    };

    let mut lowered: Vec<PetEntry> = Vec::new();
    let mut by_display: Vec<PetEntry> = Vec::new();
    for row in rows {
        let e = entry(row);
        if e.slug.is_empty() || e.spritesheet.is_empty() {
            continue;
        }
        if e.slug == name {
            return Ok(e); // 精确命中优先，不做任何模糊
        }
        if e.slug.to_ascii_lowercase() == want {
            lowered.push(e.clone());
        }
        if e.display_name.trim().to_ascii_lowercase() == want {
            by_display.push(e);
        }
    }
    if lowered.len() == 1 {
        return Ok(lowered.remove(0));
    }
    if lowered.len() > 1 {
        return Err(ambiguous("slug", &want, &lowered));
    }
    if by_display.len() == 1 {
        return Ok(by_display.remove(0));
    }
    if by_display.len() > 1 {
        return Err(ambiguous("名称", &want, &by_display));
    }
    Err(format!("Petdex 画廊里找不到名为 {name} 的桌宠"))
}

fn ambiguous(what: &str, want: &str, hits: &[PetEntry]) -> String {
    let list = hits
        .iter()
        .take(6)
        .map(|e| e.slug.as_str())
        .collect::<Vec<_>>()
        .join("、");
    format!("{what}「{want}」匹配到多个宠物，请改用具体的 slug：{list}")
}

/// 皮肤目录内的路径：slug 非法或会越出 root 时返回 Err
pub fn skin_dir(root: &Path, slug: &str) -> Result<PathBuf, String> {
    if !is_safe_slug(slug) {
        return Err(format!("非法的形象名: {slug}"));
    }
    Ok(root.join(slug))
}

/// 已装好的形象目录信息；meta.json 缺失或损坏时返回 None（不猜）
pub fn read_meta(dir: &Path) -> Option<SkinInfo> {
    let raw = fs::read(dir.join("meta.json")).ok()?;
    if !dir.join("sprite.webp").is_file() {
        return None;
    }
    let meta: Value = serde_json::from_slice(&raw).ok()?;
    let slug = meta.get("slug")?.as_str()?.to_string();
    if !is_safe_slug(&slug) {
        return None;
    }
    Some(SkinInfo {
        display_name: meta
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(&slug)
            .to_string(),
        sprite_version_number: meta
            .get("sprite_version_number")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as u32,
        url: skin_url(&slug, "sprite.webp"),
        slug,
    })
}

pub fn skin_url(slug: &str, file: &str) -> String {
    // Windows 上 WebView2 把 petskin:// 映射成 http://petskin.localhost/…
    format!("http://petskin.localhost/{slug}/{file}")
}

pub fn active_pointer(root: &Path) -> Option<String> {
    let raw = fs::read(root.join("active.json")).ok()?;
    let slug = serde_json::from_slice::<Value>(&raw)
        .ok()?
        .get("slug")
        .and_then(Value::as_str)
        .map(str::to_string)?;
    if is_safe_slug(&slug) {
        Some(slug)
    } else {
        None
    }
}

fn set_active(root: &Path, slug: &str) -> Result<(), String> {
    write_atomic(
        &root.join("active.json"),
        json!({ "slug": slug }).to_string().as_bytes(),
    )
}

/* ================= 宿主侧路径与状态 ================= */

/// 皮肤根目录：%APPDATA%/<identifier>/skins。dev 与打包版都可写（不像资源目录那样只读）
pub fn skins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到 app_data_dir: {e}"))?
        .join("skins");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ================= 网络 ================= */

fn get_bytes(url: &str, max: u64) -> Result<Vec<u8>, String> {
    let resp = agent()
        .request("GET", url)
        .call()
        .map_err(|e| format!("请求失败: {e}"))?;
    if !(200..300).contains(&resp.status()) {
        return Err(format!("{url} 返回 {}", resp.status()));
    }
    let mut buf = Vec::new();
    // 多取 1 字节：正好等于上限的合法响应不该被当成超长而拒收
    let read = resp
        .into_reader()
        .take(max + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if read as u64 > max {
        return Err("响应超过大小上限，已放弃".into());
    }
    Ok(buf)
}

/// 装一个形象：解析目录 → 下图集 → 原子落盘。已装好则直接复用（幂等）。
fn install_blocking(app: &AppHandle, name: &str) -> Result<SkinInfo, String> {
    let slug_input = normalize_name(name)?;
    let root = skins_root(app)?;

    // 已经装过同名的就不重复走网络（meta 里的 slug 必须与请求一致，否则视为没装）
    if let Ok(dir) = skin_dir(&root, &slug_input) {
        if let Some(info) = read_meta(&dir).filter(|m| m.slug == slug_input) {
            set_active(&root, &info.slug)?;
            return Ok(info);
        }
    }

    let manifest_bytes = get_bytes(MANIFEST_URL, MANIFEST_MAX_BYTES)?;
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|e| format!("目录解析失败: {e}"))?;
    let asset_base = manifest
        .get("assetBase")
        .and_then(Value::as_str)
        .unwrap_or("https://assets.petdex.dev");
    let pet = pick_pet(&manifest, &slug_input)?;
    if !is_safe_slug(&pet.slug) {
        return Err(format!("目录给出的 slug 不合法: {}", pet.slug));
    }
    let sheet = asset_url(asset_base, &pet.spritesheet)?;
    let atlas = get_bytes(&sheet, ATLAS_MAX_BYTES)?;
    if atlas.len() < 64 || &atlas[0..4] != b"RIFF" || &atlas[8..12] != b"WEBP" {
        return Err("下载到的不是 webp 图集，已放弃安装".into());
    }

    let dir = skin_dir(&root, &pet.slug)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("sprite.webp"), &atlas)?;
    // pet.json 只是附带信息，拿不到不影响换装
    if !pet.pet_json.is_empty() {
        if let Ok(url) = asset_url(asset_base, &pet.pet_json) {
            if let Ok(raw) = get_bytes(&url, 64 << 10) {
                let _ = write_atomic(&dir.join("pet.json"), &raw);
            }
        }
    }
    let meta = Meta {
        slug: pet.slug.clone(),
        display_name: pet.display_name.clone(),
        sprite_version_number: pet.version,
        asset_url: sheet,
        installed_at_ms: now_ms(),
    };
    write_atomic(
        &dir.join("meta.json"),
        serde_json::to_vec_pretty(&meta)
            .map_err(|e| e.to_string())?
            .as_slice(),
    )?;
    set_active(&root, &pet.slug)?;
    Ok(SkinInfo {
        slug: pet.slug,
        display_name: pet.display_name,
        sprite_version_number: pet.version,
        url: skin_url(&meta.slug, "sprite.webp"),
    })
}

fn installed(app: &AppHandle) -> Vec<SkinInfo> {
    let Ok(root) = skins_root(app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(info) = read_meta(&path) {
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

/* ================= IPC 命令 ================= */

fn only_settings(window: &tauri::Window) -> Result<(), String> {
    crate::gate::settings(window, "安装或切换形象")
}

/// 当前形象；没装好任何皮肤时返回 null，前端退回程序生成帧
#[tauri::command]
pub fn pet_skin_active(app: AppHandle) -> Result<Option<SkinInfo>, String> {
    let Ok(root) = skins_root(&app) else {
        return Ok(None);
    };
    let Some(slug) = active_pointer(&root) else {
        return Ok(None);
    };
    Ok(read_meta(&skin_dir(&root, &slug)?))
}

#[tauri::command]
pub fn pet_skin_list(app: AppHandle) -> Result<Vec<SkinInfo>, String> {
    Ok(installed(&app))
}

#[tauri::command]
pub async fn pet_skin_install(
    app: AppHandle,
    window: tauri::Window,
    name: String,
) -> Result<SkinInfo, String> {
    only_settings(&window)?;
    let sink = app.clone();
    let info = tauri::async_runtime::spawn_blocking(move || install_blocking(&app, &name))
        .await
        .map_err(|e| format!("安装任务失败: {e}"))??;
    let _ = sink.emit("pet:skin-changed", info.clone());
    Ok(info)
}

/// 在已安装的形象之间切换，不重新下载
#[tauri::command]
pub fn pet_skin_use(app: AppHandle, window: tauri::Window, slug: String) -> Result<SkinInfo, String> {
    only_settings(&window)?;
    let root = skins_root(&app)?;
    let info = read_meta(&skin_dir(&root, &slug)?)
        .ok_or_else(|| format!("还没有安装过 {slug}"))?;
    set_active(&root, &info.slug)?;
    let _ = app.emit("pet:skin-changed", info.clone());
    Ok(info)
}

#[tauri::command]
pub fn pet_skin_remove(app: AppHandle, window: tauri::Window, slug: String) -> Result<(), String> {
    only_settings(&window)?;
    let root = skins_root(&app)?;
    let dir = skin_dir(&root, &slug)?;
    if !dir.is_dir() {
        return Ok(()); // 幂等：不在就当删过了
    }
    // 只允许删 skins 根目录的直接子目录，别被构造出来的路径带到别处
    if dir.parent() != Some(root.as_path()) {
        return Err("非法的形象目录".into());
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    if active_pointer(&root).as_deref() == Some(slug.as_str()) {
        // 删的正是当前形象：回落到默认（还在）或列表里的第一个
        let fallback = read_meta(&skin_dir(&root, DEFAULT_SLUG)?)
            .map(|i| i.slug)
            .or_else(|| installed(&app).first().map(|i| i.slug.clone()));
        match fallback {
            Some(next) => set_active(&root, &next)?,
            None => {
                let _ = fs::remove_file(root.join("active.json"));
            }
        }
        let _ = app.emit("pet:skin-changed", ());
    }
    Ok(())
}

/* ================= petskin:// 协议 ================= */

/// `petskin://<slug>/<文件>`：把已下载的形象图集读给 webview。
/// 与插件文件的 petplugin:// 同一条路 —— 磁盘位置只有 skins_root() 一个解析点。
pub fn register_skin_protocol(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
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
        tauri::async_runtime::spawn_blocking(move || responder.respond(skin_response(&app, &path, origin)));
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
        resp.headers_mut().insert(tauri::http::header::CONTENT_TYPE, value);
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

/* ================= 启动：默认形象 ================= */

/// 首次启动（本地没有任何皮肤）时自动装默认形象。
/// 后台跑：没网络或画廊抽风时只记一条 warn，绝不能把启动卡住。
pub fn ensure_default(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(root) = skins_root(&app) else { return };
        if active_pointer(&root).is_some() || !installed(&app).is_empty() {
            return; // 已经有形象（哪怕是用户自己换过的）就不动
        }
        match install_blocking(&app, DEFAULT_SLUG) {
            Ok(info) => {
                let _ = app.emit("pet:skin-changed", info);
            }
            Err(err) => log::warn!("[skins] 默认形象 {DEFAULT_SLUG} 自动安装失败: {err}"),
        }
    });
}

/* ================= 单测 ================= */

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Value {
        json!({
            "v": 2,
            "assetBase": "https://assets.petdex.dev",
            "fields": ["slug","displayName","kind","submittedBy","spritesheet","petJson","zip","spriteVersionNumber"],
            "pets": [
                ["deepseek","deepseek酱","character","fightingshine","pets/deepseek-c3fa684cfe03/sprite.webp","pets/deepseek-c3fa684cfe03/petjson.json","pets/deepseek-c3fa684cfe03/zip.zip",1],
                ["deepseek-2","蓝色大肥鱼","character","dengqingnian","pets/deepseek-2e775a8fd69b/sprite.webp","pets/deepseek-2e775a8fd69b/petjson.json","x.zip",2],
                ["boba","Boba","character","Serhat","pets/boba-111111111111/sprite.webp","pets/boba-111111111111/petjson.json","x.zip",2],
                ["dup","同名","character","a","pets/dup-a/sprite.webp","pets/dup-a/petjson.json","x.zip",1],
                ["dup2","同名","character","b","pets/dup2-b/sprite.webp","pets/dup2-b/petjson.json","x.zip",1]
            ]
        })
    }

    #[test]
    fn pick_pet_prefers_exact_slug() {
        let e = pick_pet(&manifest(), "deepseek").unwrap();
        assert_eq!(e.slug, "deepseek");
        assert_eq!(e.version, 1);
        assert_eq!(e.spritesheet, "pets/deepseek-c3fa684cfe03/sprite.webp");
    }

    #[test]
    fn pick_pet_exact_slug_beats_case_insensitive() {
        // deepseek-2 的 slug 也含 deepseek，但精确命中优先
        assert_eq!(pick_pet(&manifest(), "DEEPSEEK").unwrap().slug, "deepseek");
    }

    #[test]
    fn pick_pet_falls_back_to_display_name() {
        assert_eq!(pick_pet(&manifest(), "Boba").unwrap().slug, "boba");
    }

    #[test]
    fn pick_pet_rejects_ambiguous_display_name() {
        let err = pick_pet(&manifest(), "同名").unwrap_err();
        assert!(err.contains("dup"), "{err}");
        assert!(err.contains("dup2"), "{err}");
    }

    #[test]
    fn pick_pet_reports_missing_name() {
        assert!(pick_pet(&manifest(), "nope").unwrap_err().contains("nope"));
    }

    #[test]
    fn pick_pet_survives_missing_optional_columns() {
        let thin = json!({
            "fields": ["slug","displayName","spritesheet"],
            "pets": [["x","X","pets/x/sprite.webp"]]
        });
        let e = pick_pet(&thin, "x").unwrap();
        assert_eq!(e.version, 1); // 没有版本列时按 v1 处理
        assert!(e.pet_json.is_empty());
    }

    #[test]
    fn pick_pet_needs_the_required_columns() {
        let broken = json!({ "fields": ["slug"], "pets": [["x"]] });
        assert!(pick_pet(&broken, "x").unwrap_err().contains("fields"));
    }

    #[test]
    fn columns_are_read_by_field_name_not_position() {
        // 把 spritesheet 挪到最后一列，仍然要能取到
        let shuffled = json!({
            "fields": ["displayName","spriteVersionNumber","slug","spritesheet"],
            "pets": [["Boba",2,"boba","pets/boba/sprite.webp"]]
        });
        assert_eq!(pick_pet(&shuffled, "boba").unwrap().spritesheet, "pets/boba/sprite.webp");
    }

    #[test]
    fn normalize_name_lowercases_and_rejects_strangers() {
        assert_eq!(normalize_name("  DeepSeek ").unwrap(), "deepseek");
        assert!(normalize_name("").is_err());
        assert!(normalize_name("../../windows").is_err());
        assert!(normalize_name("a/b").is_err());
        assert!(normalize_name("鲸鱼").is_err());
    }

    #[test]
    fn asset_url_requires_https_and_known_host() {
        let ok = asset_url("https://assets.petdex.dev", "pets/a/sprite.webp").unwrap();
        assert_eq!(ok, "https://assets.petdex.dev/pets/a/sprite.webp");
        assert!(asset_url("http://assets.petdex.dev", "pets/a/sprite.webp").is_err());
        assert!(asset_url("https://evil.example", "pets/a/sprite.webp").is_err());
        assert!(asset_url("https://assets.petdex.dev", "/etc/passwd").is_err());
        assert!(asset_url("https://assets.petdex.dev", "pets/../../win.ini").is_err());
    }

    #[test]
    fn slug_guard_blocks_traversal() {
        assert!(!is_safe_slug(".."));
        assert!(!is_safe_slug("a/b"));
        assert!(!is_safe_slug(""));
        assert!(is_safe_slug("deepseek"));
        assert!(is_safe_slug("deepseek-goldwhale-v1"));
        let root = PathBuf::from("skins");
        assert!(skin_dir(&root, "../evil").is_err());
        assert!(skin_dir(&root, "ok").is_ok());
    }

    #[test]
    fn meta_needs_both_files() {
        let dir = std::env::temp_dir().join(format!("pet-skins-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("meta.json"),
            json!({"slug":"deepseek","display_name":"deepseek酱","sprite_version_number":1}).to_string(),
        )
        .unwrap();
        assert!(read_meta(&dir).is_none(), "只有 meta 没有图集不算装好");
        fs::write(dir.join("sprite.webp"), b"RIFF....WEBP").unwrap();
        let info = read_meta(&dir).unwrap();
        assert_eq!(info.slug, "deepseek");
        assert_eq!(info.url, "http://petskin.localhost/deepseek/sprite.webp");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn meta_rejects_bad_slug_inside_file() {
        let dir = std::env::temp_dir().join(format!("pet-skins-bad-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sprite.webp"), b"RIFF").unwrap();
        fs::write(
            dir.join("meta.json"),
            json!({"slug":"../escape","display_name":"x","sprite_version_number":1}).to_string(),
        )
        .unwrap();
        assert!(read_meta(&dir).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn active_pointer_ignores_garbage() {
        let dir = std::env::temp_dir().join(format!("pet-skins-active-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(active_pointer(&dir), None);
        fs::write(dir.join("active.json"), b"not json").unwrap();
        assert_eq!(active_pointer(&dir), None);
        fs::write(dir.join("active.json"), json!({"slug":"a/b"}).to_string()).unwrap();
        assert_eq!(active_pointer(&dir), None);
        set_active(&dir, "deepseek").unwrap();
        assert_eq!(active_pointer(&dir).as_deref(), Some("deepseek"));
        fs::remove_dir_all(&dir).ok();
    }
}