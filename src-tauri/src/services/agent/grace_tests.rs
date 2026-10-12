use crate::services::agent::AgentState;

#[test]
fn straggler_post_does_not_reopen_a_stopped_session() {
    let s = AgentState::default();
    s.apply("pre", "g1", "", None);
    assert_eq!(s.aggregate(), "running");
    s.apply("stop", "g1", "", None);
    assert_eq!(s.aggregate(), "completed");
    // post 比 stop 晚到 ~150ms 是常态：不该把会话打回 running 再挂 90 秒
    s.apply("post", "g1", "", None);
    assert_eq!(s.aggregate(), "completed");
}

#[test]
fn new_prompt_voids_the_grace_window() {
    let s = AgentState::default();
    s.apply("stop", "g2", "", None);
    s.apply("user-prompt", "g2", "", Some("第二问"));
    assert_eq!(s.aggregate(), "running");
    s.apply("stop", "g2", "", None);
    assert_eq!(s.aggregate(), "completed");
}
