use super::state::{bounded_str, event_detail, prompt_title};
use super::watcher::{complete_line_prefix, resume_offset};
use serde_json::{json, Value};

use super::*;

fn payload(json: Value) -> Value {
    json!({ "phase": "pre", "at": 1, "payload": json })
}

#[test]
fn half_line_does_not_advance_the_offset() {
    // hook 写了一半：这段增量里没有换行，偏移必须原地不动，
    // 否则这一行补齐之后只剩后半截被读，事件永久丢失
    let bytes = b"{\"phase\":\"pre\",\"pay".to_vec();
    assert_eq!(None, complete_line_prefix(10, &bytes));
}

#[test]
fn offset_advances_only_past_complete_lines() {
    let bytes = b"line one\nline two\nhalf".to_vec();
    let (end, next) = complete_line_prefix(100, &bytes).unwrap();
    assert_eq!(100 + end as u64 + 1, next);
    // 下一次从 next 起读，剩下的正好是那半行
    assert_eq!(&bytes[end + 1..], b"half");
}

#[test]
fn single_complete_line_is_consumed_exactly() {
    let bytes = b"{}\n".to_vec();
    let (end, next) = complete_line_prefix(0, &bytes).unwrap();
    assert_eq!(2, end);
    assert_eq!(3, next);
}

#[test]
fn detail_prefers_command_then_path_like_fields() {
    assert_eq!(
        event_detail(&json!({"tool_input":{"command":"echo  hi   there"}})),
        "echo hi there"
    );
    assert_eq!(
        event_detail(&json!({"tool_input":{"file_path":"src/main.ts"}})),
        "src/main.ts"
    );
    assert_eq!(
        event_detail(&json!({"tool_input":{"pattern":"TODO"}})),
        "TODO"
    );
    assert_eq!(
        event_detail(&json!({"tool_input":{"todo":[{"content":"x"}]}})),
        ""
    );
}

#[test]
fn detail_is_bounded_and_single_line() {
    let long = "a".repeat(500);
    assert_eq!(
        event_detail(&json!({"tool_input":{"command":long}}))
            .chars()
            .count(),
        120
    );
    let multi = "first\nsecond\tthird";
    assert_eq!(
        event_detail(&json!({"tool_input":{"command":multi}})),
        "first second third"
    );
}

#[test]
fn title_comes_from_first_prompt_and_is_bounded() {
    assert_eq!(
        prompt_title(&json!({"prompt":"测试 Agent 桥功能\n第二行"})).as_deref(),
        Some("测试 Agent 桥功能 第二行")
    );
    assert_eq!(prompt_title(&json!({"prompt":"   "})), None);
    assert_eq!(prompt_title(&json!({"tool_input":{}})), None);
    assert!(payload(json!({})).get("payload").is_some());
}

#[test]
fn steps_count_tool_calls_and_title_survives_later_events() {
    let state = AgentState::default();
    state.apply("user-prompt", "s1", "", Some("第一个问题"));
    state.apply("pre", "s1", "", None);
    state.apply("post", "s1", "", None);
    state.apply("pre", "s1", "", Some("不该覆盖标题"));
    let (title, steps) = state.active_summary();
    assert_eq!(title, "第一个问题");
    assert_eq!(steps, 2);
}

#[test]
fn session_end_drops_that_session_only() {
    let state = AgentState::default();
    state.apply("pre", "s1", "", Some("一"));
    state.apply("pre", "s2", "", Some("二"));
    assert_eq!(state.aggregate(), "running");
    state.apply("session-end", "s1", "", None);
    assert_eq!(state.aggregate(), "running");
    let (title, _) = state.active_summary();
    assert_eq!(title, "二");
    state.apply("session-end", "s2", "", None);
    assert_eq!(state.aggregate(), "idle");
}

#[test]
fn prompt_title_truncates_to_48_chars_not_bytes() {
    // 上限 48 抄自 state.rs::prompt_title 的 `take(48)`；输入长度明显超过它，
    // 且全是三字节汉字：按字节切会把一个汉字拦腰截断（&s[..48] 直接 panic，
    // 按字节 take 则得到 16 个字），这两种退化都必须被这条断言杀掉。
    let long = "汉".repeat(60);
    let title = prompt_title(&json!({ "prompt": long })).expect("非空输入必须给出标题");
    assert_eq!(title.chars().count(), 48);
    assert_eq!(title, "汉".repeat(48));
    // 上限恰好等于输入长度的边界：不截、不越界
    let exact = "界".repeat(48);
    assert_eq!(
        prompt_title(&json!({ "prompt": exact })).as_deref(),
        Some(exact.as_str())
    );
}

#[test]
fn event_detail_truncates_to_120_chars_not_bytes() {
    // 上限 120 抄自 state.rs::event_detail 的 `take(120)`；命令是汉字，
    // 被截断的是 chars 而不是 bytes。
    let long = "命".repeat(150);
    let detail = event_detail(&json!({ "tool_input": { "command": long } }));
    assert_eq!(detail.chars().count(), 120);
    assert_eq!(detail, "命".repeat(120));
}

#[test]
fn bounded_str_keeps_exactly_max_chars() {
    // bounded_str 的现场调用点（watcher.rs）传入的上限是 96 与 64；这里用 96。
    let long = "超".repeat(100);
    let got = bounded_str(&json!({ "session_id": long }), "session_id", 96);
    assert_eq!(got.chars().count(), 96);
    assert_eq!(got, "超".repeat(96));
}

#[test]
fn unseen_file_starts_at_zero() {
    assert_eq!(resume_offset(None, 500), 0);
}

#[test]
fn offset_inside_the_file_is_kept() {
    assert_eq!(resume_offset(Some(120), 500), 120);
}

#[test]
fn offset_at_end_of_file_means_no_new_bytes() {
    assert_eq!(resume_offset(Some(500), 500), 500);
}

#[test]
fn truncated_inbox_is_read_from_the_start_again() {
    // enforce_inbox_cap 会把超过 2 MiB 的 phase 文件清空重记。
    // 此时内存里的旧偏移远大于新的 size —— 必须回退到 0，否则这个文件永久失联。
    assert_eq!(resume_offset(Some(2 * 1024 * 1024), 1024), 0);
}
