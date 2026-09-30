use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// 悬浮层的摆放方式。它是所有插件共用的一扇窗，所以位置只能由一个插件定：
/// 心率波形图要留在桌面左上角，Agent 状态卡要贴着宠物头顶，两者不能同时成立。
const PLACEMENT_CORNER: u8 = 0;
const PLACEMENT_ABOVE_PET: u8 = 1;

static PLACEMENT: AtomicU8 = AtomicU8::new(PLACEMENT_CORNER);
/// 插件的意愿：谁调过 show 且还没调 hide
static WANTED: AtomicBool = AtomicBool::new(false);
/// 实际是否在显示（宠物被游戏模式隐身时，即使 WANTED 也不显示）
static VISIBLE: AtomicBool = AtomicBool::new(false);
static SUPPRESSED: AtomicBool = AtomicBool::new(false);

fn above_pet_selected() -> bool {
    PLACEMENT.load(Ordering::SeqCst) == PLACEMENT_ABOVE_PET
}

fn place_above_pet(app: &AppHandle) {
    let (Some(pet), Some(overlay)) = (app.get_webview_window("pet"), app.get_webview_window("overlay")) else {
        return;
    };
    let Ok(pet_pos) = pet.outer_position() else { return };
    let Ok(pet_size) = pet.outer_size() else { return };
    let Ok(ov_size) = overlay.outer_size() else { return };

    let gap: i32 = 8;
    let x = pet_pos.x + (pet_size.width as i32 - ov_size.width as i32) / 2;
    // 头顶放不下就贴到宠物下沿：「看得见」优先于「在上方」
    let y = pet_pos.y - ov_size.height as i32 - gap;
    let y = if y < 0 { pet_pos.y + pet_size.height as i32 + gap } else { y };
    let _ = overlay.set_position(PhysicalPosition::new(x, y));
}

/// 把「意愿」与「是否被压制」合成实际显示状态。
/// 卡片是贴在宠物头顶的，宠物隐身时它还浮在原位既难看又泄露信息，所以一起收掉；
/// 恢复时按当时的意愿决定显不显示 —— 插件在隐身期间收过卡片（会话结束）就不会再出现。
fn apply_visibility(app: &AppHandle) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let show = WANTED.load(Ordering::SeqCst) && !SUPPRESSED.load(Ordering::SeqCst);
    if show {
        let _ = win.show();
        if above_pet_selected() {
            place_above_pet(app);
        }
    } else {
        let _ = win.hide();
    }
    VISIBLE.store(show, Ordering::SeqCst);
}

/// 宠物隐身/恢复时由宿主调用（见 window::pet::set_pet_hidden）
pub fn set_suppressed(app: &AppHandle, suppressed: bool) {
    SUPPRESSED.store(suppressed, Ordering::SeqCst);
    apply_visibility(app);
}

/// 显示（或创建）共享悬浮层。placement 传 "above-pet" 时贴着宠物头顶并跟随拖动。
///
/// 摆放方式与尺寸由**第一个表达意愿的人**决定：已经开着的时候再来一次 show，
/// 只更新意愿，不改位置也不改高度 —— 否则后启用的插件会把别人的内容拽走或压扁。
#[tauri::command]
pub async fn overlay_show(
    app: AppHandle,
    placement: Option<String>,
    height: Option<u32>,
) -> Result<(), String> {
    let first_request = !WANTED.swap(true, Ordering::SeqCst);
    if first_request {
        PLACEMENT.store(
            if placement.as_deref() == Some("above-pet") {
                PLACEMENT_ABOVE_PET
            } else {
                PLACEMENT_CORNER
            },
            Ordering::SeqCst,
        );
    }

    if app.get_webview_window("overlay").is_none() {
        let win = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("DesktopPet Overlay")
            .position(24.0, 24.0)
            .inner_size(320.0, height.unwrap_or(200) as f64)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
        // 悬浮层永远不拦截鼠标
        let _ = win.set_ignore_cursor_events(true);
    } else if first_request {
        if let Some(h) = height {
            let w = app
                .get_webview_window("overlay")
                .map(|win| win.outer_size().map(|s| s.width).unwrap_or(320))
                .unwrap_or(320);
            let _ = app
                .get_webview_window("overlay")
                .map(|win| win.set_size(PhysicalSize::new(w, h.max(48).min(900))));
        }
    }

    apply_visibility(&app);
    Ok(())
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle) -> Result<(), String> {
    WANTED.store(false, Ordering::SeqCst);
    apply_visibility(&app);
    Ok(())
}

/// 插件停用/卸载时彻底销毁 overlay，释放资源。
/// 销毁等于「没人用了」，下一次 show 可以重新决定摆放方式。
#[tauri::command]
pub async fn overlay_destroy(app: AppHandle) -> Result<(), String> {
    WANTED.store(false, Ordering::SeqCst);
    VISIBLE.store(false, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }
    Ok(())
}

/// 贴着宠物时跟随拖动。拖拽是 start_dragging 交给系统做的，宿主收不到移动事件，
/// 所以只能轮询位置 —— 且只在「实际显示且选择贴宠物」时才动，其他时候这个线程纯睡觉。
pub fn start_follow_timer(app: &AppHandle) {
    let sink = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        if !VISIBLE.load(Ordering::SeqCst) || !above_pet_selected() {
            continue;
        }
        place_above_pet(&sink);
    });
}
