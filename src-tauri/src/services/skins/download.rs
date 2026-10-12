use std::fs;
use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use tauri::AppHandle;

use crate::fsutil::write_atomic;

use super::catalog::{
    asset_url, is_safe_slug, normalize_name, pick_pet, MANIFEST_MAX_BYTES, MANIFEST_URL,
};
use super::local::{now_ms, read_meta, set_active, skin_dir, skin_url, skins_root, Meta, SkinInfo};

const ATLAS_MAX_BYTES: u64 = 12 << 20; // 实测单张 1.7~2.4 MB（VP8L 无损）
const TIMEOUT: Duration = Duration::from_secs(20);

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
pub(super) fn install_blocking(app: &AppHandle, name: &str) -> Result<SkinInfo, String> {
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
