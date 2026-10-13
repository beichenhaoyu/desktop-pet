//! Q1：授权表与同意框语义的离线单测（由 permission.rs 里 `#[cfg(test)] mod tests` 引入）。
//! 弹框那一段要真实 AppHandle，不在这里造；这里测的是能被单测覆盖的判定内核 ——
//! 声明校验、授权/撤销、持久化、同意框关闭即拒绝，恰恰是回归最容易漂的几处。
use super::*;

fn tmp_file(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pet-perm-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("建临时目录");
    dir.join("authorizations.json")
}

/// save() 需要一个已初始化的 file 路径；测试里直接指到临时文件，绕开 AppHandle
fn state_at(file: &Path) -> PermissionState {
    let state = PermissionState::new();
    *state.file.lock().unwrap_or_else(|p| p.into_inner()) = Some(file.to_path_buf());
    state
}

fn caps(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// 排序后比较：granted_caps 的顺序是授予顺序，不该被当成契约
fn deep_sorted(got: Vec<String>, want: Vec<String>) {
    let mut a = got;
    let mut b = want;
    a.sort();
    b.sort();
    assert_eq!(a, b, "授予结果（排序后）不符");
}

#[test]
fn check_capability_requires_valid_id_and_grant() {
    let state = PermissionState::new();
    assert!(
        !check_capability(&state, "todo", "storage"),
        "没授权就是没授权"
    );
    state.grant("todo", &caps(&["storage"]));
    assert!(check_capability(&state, "todo", "storage"));
    // 逐项：同一插件未授予的另一个能力仍然被拒
    assert!(!check_capability(&state, "todo", "notify"));
    // 按插件隔离：别的插件不跟着沾光
    assert!(!check_capability(&state, "com.pet.hr-ble", "storage"));
    // 非法 id 一律视为未授权 —— 就算授权表里真有这么一条脏数据
    state.grant("C:", &caps(&["storage"]));
    assert!(
        !check_capability(&state, "C:", "storage"),
        "盘符式 id 不该算已授权"
    );
    assert!(!check_capability(&state, "../evil", "storage"));
    assert!(!check_capability(&state, "", "storage"));
}

#[test]
fn grant_is_idempotent_and_cumulative() {
    let state = PermissionState::new();
    state.grant("todo", &caps(&["storage", "widget"]));
    state.grant("todo", &caps(&["storage"]));
    deep_sorted(state.granted_caps("todo"), caps(&["storage", "widget"]));
    state.grant("todo", &caps(&["notify"]));
    deep_sorted(
        state.granted_caps("todo"),
        caps(&["notify", "storage", "widget"]),
    );
}

#[test]
fn snapshots_are_copies_not_views() {
    let state = PermissionState::new();
    state.grant("todo", &caps(&["storage"]));
    let mut via_caps = state.granted_caps("todo");
    via_caps.push("ble:connect".into());
    assert!(
        !check_capability(&state, "todo", "ble:connect"),
        "改快照不该改到授权表"
    );

    let mut listed = state.list();
    listed.insert("zz.evil".to_string(), caps(&["storage"]));
    assert_eq!(state.list().len(), 1, "改 list 的返回值不该改到授权表");
}

#[test]
fn revoke_all_returns_what_it_removed() {
    let state = PermissionState::new();
    state.grant("todo", &caps(&["storage", "widget"]));
    deep_sorted(state.revoke_all("todo"), caps(&["storage", "widget"]));
    assert!(!check_capability(&state, "todo", "storage"));
    assert!(
        state.revoke_all("zz.never").is_empty(),
        "撤销没授权过的插件返回空表"
    );
}

#[test]
fn save_and_restore_roundtrip() {
    let file = tmp_file("roundtrip");
    let state = state_at(&file);
    state.grant("todo", &caps(&["storage"]));
    state.grant(
        "com.pet.astock",
        &caps(&["http", "http:push2.eastmoney.com"]),
    );
    assert!(file.exists(), "save 必须真的落盘");

    let restored = restore_from(&file).expect("刚写进去的该读得回来");
    let want = caps(&["storage"]);
    assert_eq!(restored.get("todo"), Some(&want));
    assert_eq!(restored.get("com.pet.astock").map(|v| v.len()), Some(2));
    let _ = fs::remove_dir_all(file.parent().unwrap());
}

#[test]
fn missing_file_restores_as_none() {
    let file = tmp_file("missing").join("nope.json");
    assert!(
        restore_from(&file).is_none(),
        "没有文件时按空表启动，不是报错"
    );
}

#[test]
fn corrupt_file_restores_as_none_and_is_never_overwritten() {
    // 半截的 authorizations.json 如果被当成空表写回去，用户给过的所有授权就没了 ——
    // 这条钉住「读坏就按空表跑，但绝不动原文件」
    let file = tmp_file("corrupt");
    fs::write(&file, "{ 这不是合法 json").unwrap();
    assert!(restore_from(&file).is_none());
    assert!(
        fs::read_to_string(&file).unwrap().contains("这不是合法"),
        "恢复失败不能改写原文件"
    );
    let _ = fs::remove_dir_all(file.parent().unwrap());
}

#[test]
fn retain_known_prunes_orphans_and_persists() {
    let file = tmp_file("retain");
    let state = state_at(&file);
    state.grant("todo", &caps(&["storage"]));
    state.grant("zz.gone", &caps(&["storage"]));
    let known: HashSet<String> = ["todo".to_string()].into_iter().collect();
    assert_eq!(state.retain_known(&known), vec!["zz.gone".to_string()]);
    assert_eq!(state.list().len(), 1);
    // 回收必须落盘：否则下次启动孤儿授权又回来了
    assert!(!restore_from(&file).unwrap().contains_key("zz.gone"));
    // 没有孤儿时不该重写文件
    assert!(state.retain_known(&known).is_empty());
    let _ = fs::remove_dir_all(file.parent().unwrap());
}

#[test]
fn closing_the_consent_dialog_denies_the_waiting_call() {
    // discard_pending 丢掉 sender 后等待方立刻拿到 Err ——
    // permission_request 的 `_ => Ok(false)` 分支因此按拒绝返回，不必空等 60 秒超时
    let state = PermissionState::new();
    let (tx, rx) = oneshot::channel::<bool>();
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            "r-test".to_string(),
            PendingConsent {
                sender: tx,
                plugin_id: "todo".to_string(),
                plugin_name: "待办".to_string(),
                caps: caps(&["storage"]),
            },
        );
    state.discard_pending("r-test");
    assert!(
        rx.blocking_recv().is_err(),
        "关闭同意框后等待方必须以 Err 结束"
    );
    assert!(
        state
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty(),
        "discard 要把挂起项清掉，不然它永远留在表里"
    );

    // 不存在的 req_id 不能误伤别的挂起项
    let (tx2, _rx2) = oneshot::channel::<bool>();
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            "r-keep".to_string(),
            PendingConsent {
                sender: tx2,
                plugin_id: "todo".to_string(),
                plugin_name: "待办".to_string(),
                caps: caps(&["notify"]),
            },
        );
    state.discard_pending("r-not-exist");
    assert!(
        state
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key("r-keep"),
        "按 req_id 精确丢弃"
    );
}

#[test]
fn undeclared_caps_only_accepts_what_the_manifest_declares() {
    let declared = caps(&["storage", "bus:publish", "http"]);
    assert!(undeclared_caps(&declared, &caps(&["storage"])).is_empty());
    // http 的放宽只有一条：http:<host> 视为被 http 覆盖（域名逐个授权，同一次同意框）
    assert!(
        undeclared_caps(&declared, &caps(&["http:push2.eastmoney.com"])).is_empty(),
        "按域名的请求不该被当成未声明"
    );
    // 其余一律精确匹配，不做前缀匹配（否则声明 ble 就等于给了 ble:connect）
    assert_eq!(
        undeclared_caps(&declared, &caps(&["ble:scan"])),
        caps(&["ble:scan"])
    );
    assert_eq!(
        undeclared_caps(&declared, &caps(&["storage", "notify", "pet:say"])),
        caps(&["notify", "pet:say"]),
        "报错要一次列全缺的声明"
    );
    // 空声明 = 零权限插件，任何请求都是未声明
    assert_eq!(
        undeclared_caps(&[], &caps(&["storage"])),
        caps(&["storage"])
    );
}

#[test]
fn the_http_widening_does_not_leak_to_other_capabilities() {
    // 「: 前缀算被覆盖」只对 http 成立：声明 widget 不等于给了 widget:whatever
    let declared = caps(&["widget"]);
    assert_eq!(
        undeclared_caps(&declared, &caps(&["widget:whatever"])),
        caps(&["widget:whatever"])
    );
    // 反过来：只声明 http:example.com（不是 http）也不能凭空拿到别的域名
    let declared = caps(&["http:example.com"]);
    assert_eq!(
        undeclared_caps(&declared, &caps(&["http:other.com"])),
        caps(&["http:other.com"])
    );
}

/// ADR-0005：同意框的答复口径。「明确答了是」才算授权，其余三种一律按拒绝收口 ——
/// 以前这条写在命令体的 match 里，超时/断链/关窗三种形状混在一起，看不出少没少
#[test]
fn only_an_explicit_yes_grants_consent() {
    assert!(consent_outcome(Some(true)), "用户按了允许");
    assert!(!consent_outcome(Some(false)), "用户按了拒绝");
    assert!(
        !consent_outcome(None),
        "60s 超时、通道断开、窗口被关掉都归这一档"
    );
}

/// ADR-0005：「未在 manifest 声明就不许申请」的文案与判定分开后，
/// 未声明项必须逐个出现在错误里（设置窗要照着它告诉用户缺哪条）
#[test]
fn ensure_declared_names_every_undeclared_capability() {
    let declared = caps(&["storage", "http"]);
    assert_eq!(
        ensure_declared("com.pet.x", &declared, &caps(&["storage"])),
        Ok(())
    );
    let err = ensure_declared("com.pet.x", &declared, &caps(&["ble:scan", "notify"])).unwrap_err();
    assert!(
        err.starts_with("com.pet.x 未在 manifest 声明这些能力: "),
        "实得 {err}"
    );
    assert!(
        err.contains("ble:scan") && err.contains("notify"),
        "两条都要点名，实得 {err}"
    );
    // http:<host> 被 http 覆盖这条口径不能被抽函数抽丢
    assert_eq!(
        ensure_declared("com.pet.x", &declared, &caps(&["http:example.com"])),
        Ok(())
    );
}
