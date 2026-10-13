use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::fsutil::write_atomic;

use super::catalog::is_safe_slug;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    pub slug: String,
    pub display_name: String,
    pub sprite_version_number: u32,
    pub url: String,
}

#[derive(Serialize, Debug)]
pub(super) struct Meta {
    pub(super) slug: String,
    pub(super) display_name: String,
    pub(super) sprite_version_number: u32,
    /// 图集来源，便于以后核对版本变化
    pub(super) asset_url: String,
    pub(super) installed_at_ms: u64,
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

pub(super) fn set_active(root: &Path, slug: &str) -> Result<(), String> {
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

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn installed(app: &AppHandle) -> Vec<SkinInfo> {
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

/// 删掉当前形象之后，指针该指向哪儿（ADR-0005：这条规则住在服务里，命令体只委托一次）。
/// `None` = 删的不是当前形象，指针不用动；`Some(None)` = 没有可用形象了，清掉指针；
/// `Some(Some(slug))` = 回落到默认形象（它还在）或列表里的第一个。
pub fn plan_active_after_removal(
    removed: &str,
    active: Option<&str>,
    default_slug: &str,
    remaining: &[String],
) -> Option<Option<String>> {
    if active != Some(removed) {
        return None;
    }
    let keep = |slug: &str| {
        remaining
            .iter()
            .any(|s| s == slug)
            .then(|| slug.to_string())
    };
    Some(keep(default_slug).or_else(|| remaining.first().cloned()))
}

/// 删除形象目录：幂等（目录本来不在就当删过了），且只允许删 root 的直接子目录 ——
/// 命令体里不许出现 IO，越界防护与删除动作一起收在这里。
pub fn remove_skin_dir(root: &Path, slug: &str) -> Result<bool, String> {
    let dir = skin_dir(root, slug)?;
    if dir.parent() != Some(root) {
        return Err("非法的形象目录".into());
    }
    if !dir.is_dir() {
        return Ok(false);
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 清掉当前形象指针（没有可用形象时）。
pub fn clear_active(root: &Path) -> Result<(), String> {
    match fs::remove_file(root.join("active.json")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
