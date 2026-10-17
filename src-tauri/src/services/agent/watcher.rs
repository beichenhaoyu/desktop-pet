use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use tauri::{AppHandle, Emitter, Manager};

use super::inbox::{enforce_inbox_cap, inbox_dir};
use super::state::{bounded_str, event_detail, now_ms, prompt_title, AgentState, AgentWatcher};

/// 超过这个长度的行视为畸形数据，跳过以免永久卡住读取偏移
const MAX_LINE_BYTES: usize = 256 * 1024;

/// 一批增量里能算「已消费」的部分：到最后一个换行为止。
/// 返回 (该换行的下标, 前进后的偏移)；整段里没有换行时返回 None —— 这时偏移不能动。
pub(super) fn complete_line_prefix(start: u64, bytes: &[u8]) -> Option<(usize, u64)> {
    let end = bytes.iter().rposition(|b| *b == b'\n')?;
    Some((end, start + end as u64 + 1))
}

/// 读增量该从哪一字节开始：没记过从 0 起；记过且不超过当前长度就沿用；
/// 记录比文件还大说明文件被 `enforce_inbox_cap` 清空或轮换过，**从头再读**而不是钳到末尾。
pub(super) fn resume_offset(stored: Option<u64>, size: u64) -> u64 {
    match stored {
        Some(offset) if offset <= size => offset,
        _ => 0,
    }
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
        resume_offset(offsets.get(path).copied(), size)
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

    // 联动关着：偏移量照样推进（这是「只推进偏移量」的字面意思 —— 重新启用插件时
    // 不会把这些陈旧事件当作新事件重放一遍），但不进状态机、不发 agent:event、不拨总状态。
    if !super::linkage::broadcast_allowed() {
        return;
    }

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
            // 暂停时连总状态也不拨：见 drain_file 里同一条口径的注释
            if super::linkage::broadcast_allowed() {
                state.publish(&app, None);
            }
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
        // 收件目录的上限检查照做（那是磁盘卫生，与广播无关），只是暂停时不往外拨状态
        if super::linkage::broadcast_allowed() {
            state.publish(&sink, None);
        }
    });
}
