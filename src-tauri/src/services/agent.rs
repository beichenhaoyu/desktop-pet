//! Agent hook 收件与状态归一化。
//!
//! 数据通路：编码 Agent 的 hook → 本 exe 的 `--pet-hook <phase>` 分支（只读写一个文件就退出）
//! → `agent/inbox/<phase>.jsonl` → 本模块的 watcher 读增量 → 归一化成会话状态 → 宿主总线 topic。
//!
//! 为什么不走网络：本项目本身就是桌面宠物，再装一个宠物来采事件是多余的；而开本地端口
//! 要管 token、端口占用与防火墙。落盘一行 JSONL 就够了，双方都不需要长连接。
//! 为什么不写死 identifier：hook 分支在建窗之前就返回了，拿不到 AppHandle，
//! 于是从编译期内嵌的 tauri.conf.json 读，保持单一来源。

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// 单次 hook 事件的 stdin 上限，防止某个工具把整篇 transcript 灌进来
const MAX_HOOK_BYTES: u64 = 1 << 20;
/// 超过这个长度的行视为畸形数据，跳过以免永久卡住读取偏移
const MAX_LINE_BYTES: usize = 256 * 1024;
/// 会话静默这么久就忘掉：不是所有 Agent 都会给出显式的结束事件
const SESSION_TTL: Duration = Duration::from_secs(90);
/// 「已完成 / 失败」只是短暂提示，不用等满 90 秒才让出活跃态
const FLASH_TTL: Duration = Duration::from_secs(12);
/// 单个 phase 文件的上限，超过则清空重记，避免长期运行写满盘
const INBOX_MAX_BYTES: u64 = 2 * 1024 * 1024;

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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn identifier() -> String {
    const CONF: &str = include_str!("../../tauri.conf.json");
    serde_json::from_str::<Value>(CONF)
        .ok()
        .and_then(|v| {
            v.get("identifier")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .unwrap_or_else(|| "com.desktoppet.pet".into())
}

/// 收件目录。两处调用（hook 分支与 watcher）共用这一个式子
pub fn inbox_dir(app_data: &Path) -> PathBuf {
    app_data.join("agent").join("inbox")
}

/// hook 分支没有 AppHandle，只能按 Windows 的 app_data_dir 约定自己拼
fn app_data_dir_standalone() -> Result<PathBuf, String> {
    let base = std::env::var("APPDATA").map_err(|_| "环境里没有 APPDATA".to_string())?;
    Ok(PathBuf::from(base).join(identifier()))
}

/// 收全 stdin 并落成 JSONL 的一行。这里出错一律静默返回：该分支既没有日志系统
/// 也没有窗口，报错无处可显示，更不能反过来挡住 Agent。
pub fn hook_ingest(phase: &'static str) {
    let dir = match app_data_dir_standalone().map(|p| inbox_dir(&p)) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }

    let mut buf = Vec::new();
    let _ = std::io::stdin()
        .lock()
        .take(MAX_HOOK_BYTES)
        .read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let text = text.trim();

    // 重新序列化保证「一条事件 = 一行」，否则读侧的行切分会被多行 JSON 打乱
    let line = match serde_json::from_str::<Value>(text) {
        Ok(payload) => json!({ "phase": phase, "at": now_ms(), "payload": payload }),
        Err(_) => json!({ "phase": phase, "at": now_ms(), "raw": text }),
    };
    let mut encoded = line.to_string();
    encoded.push('\n');
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{phase}.jsonl")))
    {
        let _ = file.write_all(encoded.as_bytes());
    }
}

struct Session {
    state: &'static str,
    seen: Instant,
    /// 会话标题：该会话第一条用户输入的前若干字（卡片可选显示，默认不显示）
    title: String,
    /// 已发生的工具调用步数
    steps: u32,
    /// 最近一次「这轮结束」的时刻。用于吃掉迟到的 post：
    /// pre/post 相隔约 150ms 到达，post 落在 Stop 之后是常态，
    /// 若照单处理就会把会话打回 running，而 running 的 TTL 是 90 秒 —— 症状就是
    /// 「会话早就结束了，卡片还挂着正在执行」。
    stopped_at: Option<Instant>,
}

/// Stop 之后多久之内到达的工具事件算「迟到」，不再改变会话状态
const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct AgentState {
    /// phase 文件 → 已读到的字节偏移。没有它就无法区分旧数据与新事件
    offsets: Mutex<HashMap<PathBuf, u64>>,
    sessions: Mutex<HashMap<String, Session>>,
    /// 最近一次对外广播的状态，用于只在变化时发事件
    emitted: Mutex<String>,
    counter: AtomicU64,
}

pub struct AgentWatcher {
    _inner: notify::RecommendedWatcher,
}

/// 事件 → 会话状态。词表与插件侧的动作映射对应
/// （running / needs_input / completed / failed / idle）
fn state_for_event(phase: &str, notification_kind: &str) -> Option<&'static str> {
    match phase {
        "session-start" | "user-prompt" | "pre" | "post" | "subagent-start" | "subagent-stop" => {
            Some("running")
        }
        "approval-request" => Some("needs_input"),
        "notification" => {
            if matches!(
                notification_kind,
                "permission_prompt" | "elicitation_dialog"
            ) {
                Some("needs_input")
            } else if matches!(notification_kind, "idle_prompt" | "agent_completed") {
                Some("completed")
            } else {
                None
            }
        }
        "stop" => Some("completed"),
        "tool-failure" | "stop-failure" => Some("failed"),
        "session-end" => Some("idle"),
        _ => None,
    }
}

fn ttl_for(state: &'static str) -> Duration {
    match state {
        "completed" | "failed" => FLASH_TTL,
        _ => SESSION_TTL,
    }
}

fn bounded_str(payload: &Value, key: &str, max: usize) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.chars().take(max).collect())
        .unwrap_or_default()
}

/// 从 tool_input 里挑一个最能说明「在干什么」的字段。
/// 命令与路径属于敏感内容：宿主照样带出去，是否显示由插件侧的开关决定。
fn event_detail(payload: &Value) -> String {
    const KEYS: [&str; 6] = ["command", "file_path", "path", "url", "pattern", "query"];
    let input = payload.get("tool_input");
    for key in KEYS {
        if let Some(value) = input.and_then(|v| v.get(key)).and_then(Value::as_str) {
            let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
            return one_line.chars().take(120).collect();
        }
    }
    String::new()
}

/// 会话标题取该会话第一条用户输入；换行压成空格，只留前 48 字
fn prompt_title(payload: &Value) -> Option<String> {
    let prompt = payload.get("prompt").and_then(Value::as_str)?;
    let one_line = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = one_line.chars().take(48).collect();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

impl AgentState {
    /// 记下一件事件并返回该事件的状态（词表之外的事件返回 None，不参与汇总）
    fn apply(
        &self,
        phase: &str,
        session: &str,
        kind: &str,
        title: Option<&str>,
    ) -> Option<&'static str> {
        let state = state_for_event(phase, kind)?;
        let key = if session.is_empty() {
            "default".to_string()
        } else {
            session.to_string()
        };
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        if state == "idle" {
            sessions.remove(&key);
            return Some(state);
        }
        let now = Instant::now();
        let entry = sessions.entry(key).or_insert_with(|| Session {
            state,
            seen: now,
            title: String::new(),
            steps: 0,
            stopped_at: None,
        });
        if matches!(phase, "pre" | "post" | "subagent-start" | "subagent-stop")
            && entry
                .stopped_at
                .is_some_and(|at| now.duration_since(at) < STOP_GRACE)
        {
            // 迟到的工具事件：状态保持「刚结束」，但事件照常往外发（卡片仍能更新摘要）
            return Some(entry.state);
        }
        entry.state = state;
        entry.seen = now;
        // 标题只认第一次：后续输入会把标题改成最新那句，卡片就该跟着会话走而不是跟着回合走
        if entry.title.is_empty() {
            if let Some(title) = title {
                entry.title = title.to_string();
            }
        }
        match phase {
            "stop" => entry.stopped_at = Some(now),
            // 新一轮开始，宽限期立刻作废
            "user-prompt" | "session-start" => entry.stopped_at = None,
            _ => {}
        }
        if phase == "pre" {
            entry.steps += 1;
        }
        Some(state)
    }

    /// 当前最活跃那个会话的标题与步数（卡片要显示的就是它）
    fn active_summary(&self) -> (String, u32) {
        let sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions
            .values()
            .max_by_key(|session| session.seen)
            .map(|session| (session.title.clone(), session.steps))
            .unwrap_or_default()
    }

    /// 汇总各会话：needs_input 压过 running，都没有则 idle
    fn aggregate(&self) -> &'static str {
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions.retain(|_, session| now.duration_since(session.seen) < ttl_for(session.state));
        let mut running = false;
        for session in sessions.values() {
            match session.state {
                "needs_input" => return "needs_input",
                "running" | "failed" => running = true,
                _ => {}
            }
        }
        if running {
            "running"
        } else if sessions.is_empty() {
            "idle"
        } else {
            "completed"
        }
    }

    /// 只在状态真的变化时广播，返回是否广播了
    fn publish(&self, app: &AppHandle, hint: Option<(&str, &str)>) -> bool {
        let aggregate = self.aggregate();
        let (title, steps) = self.active_summary();
        let mut emitted = self.emitted.lock().unwrap_or_else(|p| p.into_inner());
        if *emitted == aggregate {
            return false;
        }
        *emitted = aggregate.to_string();
        let counter = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let payload = match hint {
            Some((last_phase, last_state)) => json!({
                "state": aggregate,
                "counter": counter,
                "lastPhase": last_phase,
                "lastState": last_state,
                "title": title,
                "steps": steps,
            }),
            None => {
                json!({ "state": aggregate, "counter": counter, "title": title, "steps": steps })
            }
        };
        drop(emitted);
        app.emit("agent:state", payload).is_ok()
    }
}

/// 一批增量里能算「已消费」的部分：到最后一个换行为止。
/// 返回 (该换行的下标, 前进后的偏移)；整段里没有换行时返回 None —— 这时偏移不能动。
fn complete_line_prefix(start: u64, bytes: &[u8]) -> Option<(usize, u64)> {
    let end = bytes.iter().rposition(|b| *b == b'\n')?;
    Some((end, start + end as u64 + 1))
}

/// 读一个 phase 文件的增量。只消费到最后一个换行，半行留给下一次。
///
/// 偏移量只在真正消费掉若干整行之后才前进：原先是先写成 `size` 再读，
/// 于是「读失败」或「增量里还没有换行」（hook 写一半触发 watcher 的常见形状）
/// 都会把没消费的字节当成已消费，那些事件永久丢失 —— 注释里承诺的「留给下一次」并不成立。
fn drain_file(state: &Arc<AgentState>, app: &AppHandle, path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    let size = meta.len();

    let start = {
        let offsets = state.offsets.lock().unwrap_or_else(|p| p.into_inner());
        // 文件比记录的偏移小 = 被截断或轮换，从头再读
        offsets.get(path).copied().unwrap_or(0).min(size)
    };
    if start == size {
        return;
    }

    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut bytes = Vec::new();
    if (&mut file)
        .take(size - start)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return;
    }
    drop(file);

    let Some((end, next)) = complete_line_prefix(start, &bytes) else {
        // 还没有完整一行：偏移保持不动，等 hook 把这一行写完再读
        return;
    };
    state
        .offsets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(path.to_path_buf(), next);

    let phase_from_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    for line in bytes[..=end].split(|b| *b == b'\n') {
        if line.is_empty() || line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let phase = value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or(&phase_from_name);
        let payload = value.get("payload").cloned().unwrap_or(Value::Null);
        let kind = payload
            .get("notification_type")
            .or_else(|| payload.get("notification_kind"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let session = bounded_str(&payload, "session_id", 96);
        let detail = event_detail(&payload);
        let title = prompt_title(&payload);

        let Some(event_state) = state.apply(phase, &session, kind, title.as_deref()) else {
            continue;
        };
        let (title_now, steps_now) = state.active_summary();
        let _ = app.emit(
            "agent:event",
            json!({
                "phase": phase,
                "sessionId": session,
                "toolName": bounded_str(&payload, "tool_name", 64),
                // 命令/路径摘要：是否显示交给插件侧的开关
                "detail": detail,
                "notificationKind": kind,
                // 总状态只在翻转时广播，插件冷启动（会话已进行中才启用）时拿不到，
                // 所以每条事件都顺带当前会话的标题与步数，卡片不至于空白
                "title": title_now,
                "steps": steps_now,
                "at": value.get("at").and_then(Value::as_i64).unwrap_or_else(now_ms),
            }),
        );
        state.publish(app, Some((phase, event_state)));
    }
}

/// 启动时把已有文件对齐到末尾：历史事件不该在每次开机时重放一遍
fn fast_forward(state: &AgentState, dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut offsets = state.offsets.lock().unwrap_or_else(|p| p.into_inner());
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            if let Ok(meta) = fs::metadata(&path) {
                offsets.insert(path, meta.len());
            }
        }
    }
}

fn drain_all(state: &Arc<AgentState>, app: &AppHandle, dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                drain_file(state, app, &path);
            }
        }
    }
}

/// 收件目录的体积上限：超了就清空重记，宁可丢历史也不写满盘
fn enforce_inbox_cap(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if fs::metadata(&path)
            .map(|m| m.len() > INBOX_MAX_BYTES)
            .unwrap_or(false)
        {
            let _ = fs::write(&path, b"");
        }
    }
}

pub fn spawn_agent_watcher(app: &AppHandle) -> Result<AgentWatcher, String> {
    use notify::{EventKind, RecursiveMode, Watcher};

    let dir = inbox_dir(&app.path().app_data_dir().map_err(|e| e.to_string())?);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Agent 收件目录失败: {e}"))?;

    let state = app.state::<Arc<AgentState>>().inner().clone();
    fast_forward(&state, &dir);

    let sink = app.clone();
    let root = dir.clone();
    // 一次事件会连发多个通知，且落盘与通知之间有延迟：用一把闸合并成一轮，
    // 每轮扫两遍（间隔 120ms），第二遍负责吃掉刚追上来的尾巴
    let ticking = Arc::new(AtomicBool::new(false));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) {
            return;
        }
        let flag = ticking.clone();
        if flag.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = sink.clone();
        let state = state.clone();
        let root = root.clone();
        std::thread::spawn(move || {
            drain_all(&state, &app, &root);
            std::thread::sleep(Duration::from_millis(120));
            drain_all(&state, &app, &root);
            state.publish(&app, None);
            flag.store(false, Ordering::SeqCst);
        });
    })
    .map_err(|e| format!("创建 Agent 收件 watcher 失败: {e}"))?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监听 Agent 收件目录失败: {e}"))?;
    Ok(AgentWatcher { _inner: watcher })
}

/// 会话过期的兜底：没有新事件时也得有人把状态拨回 idle
pub fn start_agent_ticker(app: &AppHandle) {
    let sink = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let Ok(app_data) = sink.path().app_data_dir() else {
            continue;
        };
        let dir = inbox_dir(&app_data);
        enforce_inbox_cap(&dir);
        let state = sink.state::<Arc<AgentState>>().inner().clone();
        state.publish(&sink, None);
    });
}

#[cfg(test)]
mod tests {
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
}

#[cfg(test)]
mod grace_tests {
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
}
