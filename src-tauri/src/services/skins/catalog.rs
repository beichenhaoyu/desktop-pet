use serde_json::Value;

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

pub(super) const MANIFEST_MAX_BYTES: u64 = 16 << 20; // 目录整份约 1 MB，留足余量

/* ================= 纯函数（可单测） ================= */

/// 用户输入的名字 → slug。petdex 的 slug 只用小写字母、数字与 `-`/`_`；
/// 非法字符一律拒绝而不是清洗掉 —— 静默改写会让「输入 A 装成 B」这种误会无法排查。
pub fn normalize_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() || name.len() > 64 {
        return Err("名字为空或过长".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
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
