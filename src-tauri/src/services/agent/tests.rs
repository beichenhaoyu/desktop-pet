use super::state::{event_detail, prompt_title};
use super::watcher::complete_line_prefix;
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
