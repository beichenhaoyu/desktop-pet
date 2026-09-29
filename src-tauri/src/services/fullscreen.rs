//! 前台全屏检测 —— 游戏模式的传感部分。
//!
//! 判据做成不依赖 Win32 的纯函数（`looks_fullscreen`），这样边界能在单测里跑；
//! 采样侧任何一步失败都按「没有全屏」返回：误隐身比漏隐身难受得多。
//!
//! 为什么不用 SetWinEventHook 听前台变化：那需要一个消息循环，而本宿主没有自己的
//! 线程消息泵。1.2 秒一次的轮询只有几个 user32 调用，代价可以忽略。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 桌面宿主窗口（壁纸/图标层）不算全屏
pub const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_SecondaryWindow"];

/// 是否算「某个应用占满了整块显示器」。
/// 各参数是采样侧算好的结论，本函数只做判断，便于单测。
pub fn looks_fullscreen(
    fg: Rect,
    monitor: Rect,
    has_caption: bool,
    iconic: bool,
    same_process: bool,
    shell_class: bool,
) -> bool {
    if same_process || shell_class || iconic {
        return false;
    }
    // 带标题栏的窗口哪怕铺满整块屏幕，也只该被当成最大化窗口。
    // 真正的游戏/演示全屏与浏览器的 F11 都是无边框的。
    if has_caption {
        return false;
    }
    // 必须盖满整块显示器（含任务栏区域）；只盖住工作区的是最大化窗口
    const TOL: i32 = 2; // DPI 缩放与边框取整带来的零头
    fg.x <= monitor.x + TOL
        && fg.y <= monitor.y + TOL
        && fg.x + fg.w >= monitor.x + monitor.w - TOL
        && fg.y + fg.h >= monitor.y + monitor.h - TOL
}

static WATCHING: AtomicBool = AtomicBool::new(false);
static LAST_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 最近一次采样的输入与结论。设置窗拿它显示「当前前台是什么、为什么没触发」，
/// 端到端断言也靠它区分「没检测到」与「检测到了但没隐身」
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Snapshot {
    pub foreground: String,
    pub fg_rect: [i32; 4],
    pub monitor: [i32; 4],
    pub has_caption: bool,
    pub same_process: bool,
    pub shell: bool,
    pub active: bool,
    pub sampled_at: i64,
}

static LAST_SNAPSHOT: std::sync::Mutex<Option<Snapshot>> = std::sync::Mutex::new(None);

pub fn last_snapshot() -> Snapshot {
    LAST_SNAPSHOT
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

fn record(snapshot: Snapshot) {
    if let Ok(mut guard) = LAST_SNAPSHOT.lock() {
        *guard = Some(snapshot);
    }
}

pub fn watch_enabled() -> bool {
    WATCHING.load(Ordering::Relaxed)
}

/// 采样一次前台窗口，给出判据输入与结论
#[cfg(windows)]
fn sample() -> Snapshot {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GWL_STYLE, IsIconic, IsWindowVisible, WS_CAPTION,
    };

    let mut snap = Snapshot {
        sampled_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        ..Default::default()
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return snap;
        }
        let mut rect = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return snap;
        }
        snap.fg_rect = [rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top];
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return snap;
        }

        let mut class = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class) as usize;
        let class_name = String::from_utf16_lossy(&class[..class_len]);
        let mut title = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title) as usize;
        let name = String::from_utf16_lossy(&title[..title_len]);
        snap.foreground = if name.is_empty() { class_name.clone() } else { name };
        snap.foreground = snap.foreground.chars().take(120).collect();

        snap.shell = SHELL_CLASSES
            .iter()
            .any(|shell| class_name.eq_ignore_ascii_case(shell));

        // 自己的窗口（宠物、设置、同意框）按进程号排除：
        // 不去比 HWND 类型，免得和 tauri 依赖的 windows 版本对不上
        let mut pid = 0u32;
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
        snap.same_process = pid == std::process::id();

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        snap.has_caption = style & WS_CAPTION.0 != 0;

        let handle = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if handle.0.is_null() {
            return snap;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(handle, &mut info).as_bool() {
            return snap;
        }
        snap.monitor = [
            info.rcMonitor.left,
            info.rcMonitor.top,
            info.rcMonitor.right - info.rcMonitor.left,
            info.rcMonitor.bottom - info.rcMonitor.top,
        ];

        // fg_rect 里存的已经是 [x, y, 宽, 高]，不能再按 ltrb 换算一次
        let fg = Rect {
            x: snap.fg_rect[0],
            y: snap.fg_rect[1],
            w: snap.fg_rect[2],
            h: snap.fg_rect[3],
        };
        let monitor = Rect {
            x: snap.monitor[0],
            y: snap.monitor[1],
            w: snap.monitor[2],
            h: snap.monitor[3],
        };
        snap.active = looks_fullscreen(
            fg,
            monitor,
            snap.has_caption,
            false,
            snap.same_process,
            snap.shell,
        );
        snap
    }
}

#[cfg(not(windows))]
fn sample() -> Snapshot {
    Snapshot::default()
}

/// 进出全屏都要看最近三次采样的多数票，而不是「连续两次一致」：
/// 后台聊天软件之类的程序会间歇抢走前台，逐帧判定时会 F/. 交替，
/// 连续型迟滞永远攒不满（实测就是这样导致宠物一直不隐身）。
/// 进全屏要 ≥2/3，退全屏要 0/3 —— 出去的条件更严，避免来回抖。
static HISTORY: AtomicU32 = AtomicU32::new(0);
const WINDOW_BITS: u32 = 0b111;

fn consider(app: &AppHandle, snap: &Snapshot) {
    let hist =
        ((HISTORY.load(Ordering::SeqCst) << 1) & WINDOW_BITS) | u32::from(snap.active);
    HISTORY.store(hist, Ordering::SeqCst);
    let positives = hist.count_ones();
    let current = LAST_ACTIVE.load(Ordering::SeqCst);
    let next = if positives >= 2 {
        true
    } else if positives == 0 {
        false
    } else {
        current
    };
    if next == current {
        return;
    }
    LAST_ACTIVE.store(next, Ordering::SeqCst);
    let _ = app.emit(
        "host:fullscreen",
        serde_json::json!({ "active": next, "title": snap.foreground }),
    );
}

pub fn start(app: &AppHandle) {
    let sink = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1200));
        if !watch_enabled() {
            // 关掉功能时强制把「不在全屏」补发一次，别让宠物停在隐藏状态
            let blank = Snapshot::default();
            if LAST_ACTIVE.swap(false, Ordering::SeqCst) {
                let _ = sink.emit("host:fullscreen", serde_json::json!({ "active": false, "title": "" }));
            }
            record(blank);
            continue;
        }
        let snap = sample();
        consider(&sink, &snap);
        record(snap);
    });
}

#[tauri::command]
pub fn fullscreen_watch_set(enabled: bool, window: tauri::Window) -> bool {
    // 只有宠物窗与设置窗能开关这个传感；插件用不上，也不该被第三方驱动着隐身
    if !matches!(window.label(), "pet" | "settings") {
        return watch_enabled();
    }
    WATCHING.store(enabled, Ordering::SeqCst);
    HISTORY.store(0, Ordering::SeqCst); // 开关切换时清空投票窗口，别拿旧样本投票
    if !enabled {
        LAST_ACTIVE.store(true, Ordering::SeqCst); // 强制下一次广播把 active=false 发出去
    }
    enabled
}

#[tauri::command]
pub fn fullscreen_watch_status() -> bool {
    watch_enabled()
}

/// 最近一次采样的输入与结论，供设置窗显示与端到端断言取证
#[tauri::command]
pub fn fullscreen_probe() -> Snapshot {
    last_snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1080,
    };

    #[test]
    fn borderless_window_covering_the_monitor_is_fullscreen() {
        assert!(looks_fullscreen(
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            MON,
            false,
            false,
            false,
            false
        ));
    }

    #[test]
    fn second_monitor_offset_origin_still_counts() {
        let monitor = Rect {
            x: 1920,
            y: 0,
            w: 2560,
            h: 1440,
        };
        assert!(looks_fullscreen(
            Rect {
                x: 1920,
                y: 0,
                w: 2560,
                h: 1440
            },
            monitor,
            false,
            false,
            false,
            false
        ));
    }

    #[test]
    fn maximized_window_is_not_fullscreen() {
        // 最大化窗口只盖住工作区（1080 - 40 任务栏），且带标题栏 —— 两条都不满足
        assert!(!looks_fullscreen(
            Rect { x: 0, y: 0, w: 1920, h: 1040 },
            MON,
            true,
            false,
            false,
            false
        ));
        // 任务栏隐藏时最大化窗口能铺满整屏，但带标题栏，仍不算
        assert!(!looks_fullscreen(
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            MON,
            true,
            false,
            false,
            false
        ));
    }

    #[test]
    fn window_smaller_than_the_monitor_is_not_fullscreen() {
        assert!(!looks_fullscreen(
            Rect { x: 10, y: 0, w: 1900, h: 1080 },
            MON,
            false,
            false,
            false,
            false
        ));
    }

    #[test]
    fn our_own_windows_never_trigger_it() {
        assert!(!looks_fullscreen(
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            MON,
            false,
            false,
            true,
            false
        ));
    }

    #[test]
    fn desktop_shell_never_triggers_it() {
        assert!(!looks_fullscreen(
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            MON,
            false,
            false,
            false,
            true
        ));
    }

    #[test]
    fn minimized_never_triggers_it() {
        assert!(!looks_fullscreen(
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            MON,
            false,
            true,
            false,
            false
        ));
    }

    #[test]
    fn sub_pixel_rounding_is_tolerated() {
        // 四舍五入少一两个像素仍算全屏，否则高 DPI 下会反复抖动
        assert!(looks_fullscreen(
            Rect { x: 1, y: 1, w: 1918, h: 1078 },
            MON,
            false,
            false,
            false,
            false
        ));
    }
}
