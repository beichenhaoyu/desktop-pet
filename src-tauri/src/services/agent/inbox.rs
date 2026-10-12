use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::phases::MAX_HOOK_BYTES;
use super::state::{identifier, now_ms};

/// 单个 phase 文件的上限，超过则清空重记，避免长期运行写满盘
const INBOX_MAX_BYTES: u64 = 2 * 1024 * 1024;

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

/// 收件目录的体积上限：超了就清空重记，宁可丢历史也不写满盘
pub(super) fn enforce_inbox_cap(dir: &Path) {
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
