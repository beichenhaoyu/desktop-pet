use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::host_error::{INVALID_ARG, IO, NOT_FOUND, PARSE};

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
    assert!(err.message.contains("dup"), "{err}");
    assert!(err.message.contains("dup2"), "{err}");
}

#[test]
fn pick_pet_reports_missing_name() {
    assert!(pick_pet(&manifest(), "nope")
        .unwrap_err()
        .message
        .contains("nope"));
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
    assert!(pick_pet(&broken, "x")
        .unwrap_err()
        .message
        .contains("fields"));
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

/* ============ A2 / ADR-0007：5 条命令各自拿到的码，逐条点名钉住 ============ */

#[test]
fn pet_skin_list_signature_declares_host_error() {
    // pet_skin_list 没有错误产生点（installed() 把读目录失败吞成空表），码无处可点名。
    // 而测试里引用命令函数的符号（取地址）会把 tauri 命令机制拉进测试 exe 的链接：
    // 实测导入 comctl32 的 v6-only 导出后测试 exe 直接 0xc0000139 起不来（A/B/A 三次复现），
    // 所以 list 的签名改在源码文本层钉住（cargo check / check:shape 另有两道机器门）。
    let flat = include_str!("commands.rs")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        flat.contains("pub fn pet_skin_list(app: AppHandle) -> Result<Vec<SkinInfo>, HostError>"),
        "pet_skin_list 的 Err 侧必须是 HostError"
    );
}

#[test]
fn pet_skin_install_rejects_bad_name_with_invalid_arg() {
    // install 入参先过 normalize_name：空名与非法字符都是调用方的输入问题 → invalid-arg
    let empty = normalize_name("").unwrap_err();
    assert_eq!(empty.code, INVALID_ARG, "空名不是 not-found 也不是 parse");
    assert_eq!(
        empty.message, "名字为空或过长",
        "文案是 verify 的文本判据，一字不动"
    );
    let bad = normalize_name("a/b").unwrap_err();
    assert_eq!(bad.code, INVALID_ARG);
    assert_eq!(bad.message, "名字不合法（只允许字母、数字、- 与 _）: a/b");
}

#[test]
fn pet_skin_install_reports_ambiguous_name_as_invalid_arg() {
    // displayName 命中多条时不猜、报候选：「换更具体的名字」是入参问题 → invalid-arg
    let err = pick_pet(&manifest(), "同名").unwrap_err();
    assert_eq!(
        err.code, INVALID_ARG,
        "歧义名不该混进 not-found（名字不是不存在）"
    );
    assert!(
        err.message.contains("dup") && err.message.contains("dup2"),
        "候选列表要在文案里: {err}"
    );
}

#[test]
fn pet_skin_install_reports_parse_when_catalog_shape_is_wrong() {
    // 远端内容形状不对（缺列/缺 pets）与 assetBase 非法都是 parse —— 网络通了但内容坏了
    let missing_columns =
        pick_pet(&json!({ "fields": ["slug"], "pets": [["x"]] }), "x").unwrap_err();
    assert_eq!(missing_columns.code, PARSE);
    assert_eq!(
        missing_columns.message,
        "目录响应缺少 fields 里的 slug/displayName/spritesheet 列"
    );
    let missing_pets = pick_pet(
        &json!({ "fields": ["slug","displayName","spritesheet"] }),
        "x",
    )
    .unwrap_err();
    assert_eq!(missing_pets.code, PARSE);
    assert_eq!(missing_pets.message, "目录响应里没有 pets 数组");
    let scheme = asset_url("http://assets.petdex.dev", "pets/a/sprite.webp").unwrap_err();
    assert_eq!(scheme.code, PARSE, "URL 形状坏归 parse，不是 network");
    assert_eq!(scheme.message, "图集只走 https，收到 http");
}

#[test]
fn pet_skin_install_reports_not_found_for_unknown_name() {
    // 画廊查无此名 = 「资源名字不存在」→ not-found，文案一字不动
    let err = pick_pet(&manifest(), "nope").unwrap_err();
    assert_eq!(err.code, NOT_FOUND, "查不到名字不该混进 invalid-arg");
    assert_eq!(err.message, "Petdex 画廊里找不到名为 nope 的桌宠");
}

#[test]
fn pet_skin_active_surfaces_invalid_arg_for_escaping_slug() {
    // active/use/remove/install 的 slug 把关都走 skin_dir；穿越名一律 invalid-arg。
    // active 唯一的 Err 产生点就是这条（meta 读不到是 Ok(None)，不是错）
    let err = skin_dir(&PathBuf::from("skins"), "../evil").unwrap_err();
    assert_eq!(err.code, INVALID_ARG);
    assert_eq!(err.message, "非法的形象名: ../evil");
}

#[test]
fn pet_skin_use_surfaces_invalid_arg_for_escaping_slug() {
    // use 对越界 slug 的拒绝来自同一把关（skin_dir），单据一条备查
    let err = skin_dir(&PathBuf::from("skins"), "../evil").unwrap_err();
    assert_eq!(err.code, INVALID_ARG);
    assert_eq!(err.message, "非法的形象名: ../evil");
}

#[test]
fn pet_skin_remove_surfaces_invalid_arg_for_escaping_slug() {
    // remove 的拒绝链路是 remove_skin_dir → skin_dir，同样 invalid-arg
    let root = std::env::temp_dir().join(format!("pet-skins-rm-a03-{}", now_ms()));
    let err = remove_skin_dir(&root, "../escape").unwrap_err();
    assert_eq!(err.code, INVALID_ARG);
    assert_eq!(err.message, "非法的形象名: ../escape");
}

#[test]
fn pet_skin_use_surfaces_io_when_pointer_write_fails() {
    // use 切换形象要落 active.json（set_active → write_atomic）：父路径被文件占住 →
    // 创建目录失败 → io，且 message 保留 fsutil 的上下文原文，不能被 io(e) 抹平
    let base = std::env::temp_dir().join(format!("pet-skins-use-io-{}", now_ms()));
    let _ = fs::remove_dir_all(&base);
    let _ = fs::remove_file(&base);
    fs::write(&base, "占位文件，不是目录").unwrap();
    let err = set_active(&base, "deepseek").unwrap_err();
    assert_eq!(err.code, IO, "落盘失败是 io 码");
    assert!(
        err.message.contains("创建目录失败"),
        "fsutil 的上下文文案要保真: {}",
        err.message
    );
    fs::remove_file(&base).ok();
}

#[test]
fn pet_skin_remove_surfaces_io_when_pointer_clear_fails() {
    // remove 删最后一个形象时 clear_active 走 remove_file：active.json 被同名目录占住 →
    // 删除失败 → io（NotFound 之外的错误不能再被当成「本来就不在」吞掉）
    let root = std::env::temp_dir().join(format!("pet-skins-clear-io-{}", now_ms()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("active.json")).unwrap();
    let err = clear_active(&root).unwrap_err();
    assert_eq!(err.code, IO, "删除失败是 io 码");
    fs::remove_dir_all(&root).ok();
}
