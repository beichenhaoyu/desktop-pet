use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::catalog::DEFAULT_SLUG;
use super::local::{
    active_pointer, clear_active, now_ms, plan_active_after_removal, remove_skin_dir, set_active,
};

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
    assert_eq!(
        pick_pet(&shuffled, "boba").unwrap().spritesheet,
        "pets/boba/sprite.webp"
    );
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
        json!({"slug":"deepseek","display_name":"deepseek酱","sprite_version_number":1})
            .to_string(),
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

/* ============ ADR-0005：删除形象的规则从命令体抽出来，逐条点名钉住 ============ */

#[test]
fn plan_active_after_removal_keeps_pointer_when_other_skin_deleted() {
    let remaining = vec!["deepseek".to_string(), "todo".to_string()];
    assert_eq!(
        plan_active_after_removal("todo", Some("deepseek"), DEFAULT_SLUG, &remaining),
        None,
        "删的不是当前形象时指针不该动"
    );
}

#[test]
fn plan_active_after_removal_falls_back_to_default_when_default_still_installed() {
    let remaining = vec!["aaa".to_string(), DEFAULT_SLUG.to_string()];
    assert_eq!(
        plan_active_after_removal(DEFAULT_SLUG, Some(DEFAULT_SLUG), DEFAULT_SLUG, &remaining)
            .and_then(|x| x),
        // 删的就是当前形象：回落到默认（它还在）
        Some(DEFAULT_SLUG.to_string()),
        "默认形象还在列表里就该回落到它"
    );
    let without_default = vec!["zzz".to_string(), "aaa".to_string()];
    assert_eq!(
        plan_active_after_removal("aaa", Some("aaa"), DEFAULT_SLUG, &without_default)
            .and_then(|x| x),
        Some("zzz".to_string()),
        "默认不在了就取列表第一个（installed 已按 slug 排序）"
    );
}

#[test]
fn plan_active_after_removal_clears_pointer_when_nothing_left() {
    assert_eq!(
        plan_active_after_removal("only", Some("only"), DEFAULT_SLUG, &[]),
        Some(None),
        "一个形象都不剩时清掉指针，而不是指向不存在的目录"
    );
}

#[test]
fn remove_skin_dir_is_idempotent_and_only_touches_direct_children() {
    let root = std::env::temp_dir().join(format!("pet-skins-rm-{}", now_ms()));
    fs::create_dir_all(root.join("deepseek")).unwrap();
    assert_eq!(
        remove_skin_dir(&root, "deepseek"),
        Ok(true),
        "第一次真的删掉了"
    );
    assert_eq!(
        remove_skin_dir(&root, "deepseek"),
        Ok(false),
        "再来一次当删过了"
    );
    // 越界的 slug 由 skin_dir 的字符白名单挡下（含 `/` 与 `..`）
    assert!(
        remove_skin_dir(&root, "../escape").is_err(),
        "相对逃逸的 slug 必须报错"
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn clear_active_is_ok_when_pointer_missing_and_removes_it_when_present() {
    let root = std::env::temp_dir().join(format!("pet-skins-clear-{}", now_ms()));
    fs::create_dir_all(&root).unwrap();
    assert_eq!(
        clear_active(&root),
        Ok(()),
        "指针本来不在就当清过了（幂等）"
    );
    set_active(&root, "deepseek").unwrap();
    assert_eq!(active_pointer(&root).as_deref(), Some("deepseek"));
    assert_eq!(clear_active(&root), Ok(()));
    assert_eq!(active_pointer(&root), None, "清过之后读不到指针");
    fs::remove_dir_all(&root).ok();
}
