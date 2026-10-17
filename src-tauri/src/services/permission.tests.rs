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
/// 未声明项必须逐个出现在错误里（设置窗要照着它告诉用户缺哪条）。
/// A2/ADR-0007：这条拒绝的码是 denied（授权缺失），不是 not-found / invalid-arg。
#[test]
fn ensure_declared_names_every_undeclared_capability() {
    let declared = caps(&["storage", "http"]);
    assert_eq!(
        ensure_declared("com.pet.x", &declared, &caps(&["storage"])),
        Ok(())
    );
    let err = ensure_declared("com.pet.x", &declared, &caps(&["ble:scan", "notify"])).unwrap_err();
    assert_eq!(err.code, DENIED, "未声明 = 授权缺失，denied 码");
    assert!(
        err.message
            .starts_with("com.pet.x 未在 manifest 声明这些能力: "),
        "实得 {err}"
    );
    assert!(
        err.message.contains("ble:scan") && err.message.contains("notify"),
        "两条都要点名，实得 {err}"
    );
    // http:<host> 被 http 覆盖这条口径不能被抽函数抽丢
    assert_eq!(
        ensure_declared("com.pet.x", &declared, &caps(&["http:example.com"])),
        Ok(())
    );
}

/* ============ A2 / ADR-0007：5 条命令各自拿到的码，逐条点名钉住 ============ */

/// permission_request / permission_revoke：非法 id 的码是 invalid-arg，文案一字不变
/// （与「没授权」的 denied 分开 —— 同文案跨命令同码组，见 T12 cross-command §1）
#[test]
fn invalid_plugin_id_is_invalid_arg() {
    let err = checked_plugin_id("../evil").unwrap_err();
    assert_eq!(err.code, INVALID_ARG, "非法 id 不能混进 denied");
    assert_eq!(err.message, "invalid plugin id");
    assert!(checked_plugin_id("com.pet.x").is_ok());
}

/// permission_request：同意框开窗失败 = 宿主内部失败 → internal（挂起项已在同一处清掉）
#[test]
fn consent_window_failure_is_internal() {
    let err = consent_window_error(tauri::Error::UnknownPath);
    assert_eq!(err.code, INTERNAL, "开窗失败是宿主内部问题，不是调用方的错");
}

/// consent_details / consent_answer：同意框只能由它自己的窗口应答 → denied（S3）
#[test]
fn a_foreign_window_answering_consent_is_denied() {
    assert!(assert_consent_caller("consent-r1", "r1").is_ok());
    let err = assert_consent_caller("consent-r2", "r1").unwrap_err();
    assert_eq!(err.code, DENIED, "答非所窗是 denied 码");
    assert_eq!(err.message, "consent window does not own this request");
}

/// consent_details：挂起项查不到 → not-found；查得到就把详情原样给出
#[test]
fn consent_details_missing_request_is_not_found() {
    let state = PermissionState::new();
    // 用 .err() 而不是 unwrap_err：ConsentDetails 没实现 Debug，unwrap_err 会因 T: Debug 约束编译不过
    let err = pending_details(&state, "r-nope")
        .err()
        .expect("查不到挂起项该报错");
    assert_eq!(err.code, NOT_FOUND, "挂起项查不到不该混进 denied");
    assert_eq!(err.message, "request not found");

    let (tx, _rx) = oneshot::channel::<bool>();
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            "r-1".to_string(),
            PendingConsent {
                sender: tx,
                plugin_id: "todo".to_string(),
                plugin_name: "待办".to_string(),
                caps: caps(&["storage"]),
            },
        );
    let d = pending_details(&state, "r-1").unwrap();
    assert_eq!(d.req_id, "r-1");
    assert_eq!(d.plugin_id, "todo");
    assert_eq!(d.plugin_name, "待办");
    assert_eq!(d.caps, caps(&["storage"]));
}

/// consent_answer：查不到挂起项 → not-found；等待方已经走了 → internal。
/// 后者既不是 denied 也不是 consent-timeout：用户既没同意也没拒绝，是通道自己断了。
#[test]
fn consent_answer_reports_not_found_and_dropped_receiver() {
    let state = PermissionState::new();
    let missing = answer_pending(&state, "r-nope", true).unwrap_err();
    assert_eq!(missing.code, NOT_FOUND);
    assert_eq!(missing.message, "request not found");

    let (tx, rx) = oneshot::channel::<bool>();
    drop(rx);
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            "r-2".to_string(),
            PendingConsent {
                sender: tx,
                plugin_id: "todo".to_string(),
                plugin_name: "待办".to_string(),
                caps: caps(&["storage"]),
            },
        );
    let dropped = answer_pending(&state, "r-2", true).unwrap_err();
    assert_eq!(dropped.code, INTERNAL, "通道断开是宿主内部时序");
    assert_eq!(dropped.message, "receiver dropped");
}

/// consent_answer：用户的决定要送达等待方，回传即出队（窗口关闭那一路靠 discard_pending）
#[test]
fn consent_answer_delivers_the_decision_and_clears_the_pending_item() {
    let state = PermissionState::new();
    let (tx, rx) = oneshot::channel::<bool>();
    state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            "r-3".to_string(),
            PendingConsent {
                sender: tx,
                plugin_id: "todo".to_string(),
                plugin_name: "待办".to_string(),
                caps: caps(&["storage"]),
            },
        );
    assert!(answer_pending(&state, "r-3", true).is_ok());
    assert!(
        rx.blocking_recv().unwrap(),
        "用户按了允许，等待方要收到 true"
    );
    assert!(
        !state
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key("r-3"),
        "回传即出队"
    );
}

/// permission_list：体内没有错误产生点，唯一失败链是 gate（真实窗口单测构造不出来），
/// 签名改在源码文本层钉住 —— 与 skins/tests.rs 的 pet_skin_list 同款（A03 实测）。
#[test]
fn permission_list_signature_declares_host_error() {
    let flat = include_str!("permission.rs")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        flat.contains(
            "pub fn permission_list( window: tauri::Window, state: tauri::State<PermissionState>, ) -> Result<HashMap<String, Vec<String>>, HostError> {"
        ),
        "permission_list 的 Err 侧必须是 HostError"
    );
    // 门禁不能被顺手挪走：唯一失败链的码（denied）由 gate.rs 的既有断言覆盖
    assert!(
        flat.contains("crate::gate::settings(&window, \"查看授权表\")?;"),
        "permission_list 必须继续走设置窗门禁"
    );
}

/// permission_request / consent_details / consent_answer / permission_revoke：
/// 四条命令体直接依赖真实窗口/AppHandle，单测拿不到函数地址（会把 tauri 命令机制
/// 拉进测试 exe 链接，见 A03 实测），签名同样在源码文本层钉住。
#[test]
fn the_other_command_signatures_declare_host_error() {
    let flat = include_str!("permission.rs")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        flat.contains(
            "pub async fn permission_request( app: AppHandle, state: tauri::State<'_, PermissionState>, plugin_id: String, capabilities: Vec<String>, ) -> Result<bool, HostError> {"
        ),
        "permission_request 的 Err 侧必须是 HostError"
    );
    // ADR-0011：同意框上的名字不再由调用方传入，签名里就不该再有 plugin_name。
    // 这条是负向钉 —— 谁把入参加回来（哪怕只是"顺手带上"），这里当场红。
    assert!(
        !flat.contains(
            "pub async fn permission_request( app: AppHandle, state: tauri::State<'_, PermissionState>, plugin_id: String, plugin_name:"
        ),
        "permission_request 不许再收调用方自报的 plugin_name（ADR-0011：名字只认磁盘 manifest）"
    );
    assert!(
        flat.contains(
            "pub fn consent_details( window: tauri::Window, state: tauri::State<PermissionState>, req_id: String, ) -> Result<ConsentDetails, HostError> {"
        ),
        "consent_details 的 Err 侧必须是 HostError"
    );
    assert!(
        flat.contains(
            "pub fn consent_answer( window: tauri::Window, state: tauri::State<PermissionState>, req_id: String, granted: bool, ) -> Result<(), HostError> {"
        ),
        "consent_answer 的 Err 侧必须是 HostError"
    );
    assert!(
        flat.contains(
            "pub fn permission_revoke( app: AppHandle, window: tauri::Window, plugin_id: String, state: tauri::State<PermissionState>, store: tauri::State<StoreState>, ) -> Result<Vec<String>, HostError> {"
        ),
        "permission_revoke 的 Err 侧必须是 HostError"
    );
}
