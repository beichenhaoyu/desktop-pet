/// 单次 hook 事件的 stdin 上限，防止某个工具把整篇 transcript 灌进来
pub(super) const MAX_HOOK_BYTES: u64 = 1 << 20;

/// (Agent 事件名, 我们的 phase)。phase 既是文件名也是 CLI 参数，两者共用这张表
pub const HOOK_PHASES: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("PreToolUse", "pre"),
    ("PostToolUse", "post"),
    ("PostToolUseFailure", "tool-failure"),
    ("PermissionRequest", "approval-request"),
    ("Notification", "notification"),
    ("SubagentStart", "subagent-start"),
    ("SubagentStop", "subagent-stop"),
    ("StopFailure", "stop-failure"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
];

/// 命中 `--pet-hook <phase>` 时返回该 phase。phase 必须在白名单内：
/// 它会被拼成文件名，不接受任意字符串。
pub fn hook_phase_from_args<I: Iterator<Item = String>>(args: &mut I) -> Option<&'static str> {
    while let Some(arg) = args.next() {
        if arg != "--pet-hook" {
            continue;
        }
        let raw = args.next()?;
        return HOOK_PHASES
            .iter()
            .map(|(_, p)| *p)
            .find(|p| *p == raw.as_str());
    }
    None
}
