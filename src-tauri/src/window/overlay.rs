use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// 悬浮层的摆放方式。
const PLACEMENT_CORNER: u8 = 0;
const PLACEMENT_ABOVE_PET: u8 = 1;

/// 每个插件一扇自己的悬浮窗（`overlay-<插件 id>`）。
///
/// 早先所有插件共用一扇 `overlay` 窗，位置与高度由第一个 show 的人定死：
/// 心率波形要留在桌面左上角、Agent 状态卡要贴着宠物头顶，两者不可能同时成立，
/// 结果后打开的那个被塞进同一扇窗里显示不出来。窗口按插件分开之后，
/// 每扇窗的位置、高度、显隐都只属于它自己的插件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OverlayState {
    placement: u8,
    /// 插件的意愿：调过 show 且还没 hide
    wanted: bool,
    /// 实际是否在显示（游戏模式压制时 wanted 也不显示）
    visible: bool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            placement: PLACEMENT_CORNER,
            wanted: false,
            visible: false,
        }
    }
}
static OVERLAYS: OnceLock<Mutex<HashMap<String, OverlayState>>> = OnceLock::new();

/// 游戏模式隐身：对**所有**悬浮层生效，不只是某一只插件的
static SUPPRESSED: AtomicBool = AtomicBool::new(false);

fn table() -> &'static Mutex<HashMap<String, OverlayState>> {
    OVERLAYS.get_or_init(Default::default)
}

/// 窗口标签只允许字母数字与 `-` `/` `:` `_`，而插件 id 里带点号（`com.pet.hr-ble`），
/// 所以标签是净化过的、**不能反推**出 id：页面要确认自己服务哪个插件得回头问宿主
/// （`overlay_owner`），注册表才是归属的唯一来源。
pub fn overlay_label(plugin_id: &str) -> String {
    let cleaned: String = plugin_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("overlay-{cleaned}")
}

fn owner_of_label(label: &str) -> Option<String> {
    let guard = table().lock().unwrap();
    guard
        .keys()
        .find(|id| overlay_label(id) == label)
        .cloned()
}

/// 悬浮窗页面问宿主「这扇窗是给谁的」——按调用者的窗口标签回答，前端伪造不了归属
#[tauri::command]
pub async fn overlay_owner(window: tauri::Window) -> Result<Option<String>, String> {
    Ok(owner_of_label(window.label()))
}

const WIDTH: f64 = 320.0;
const DEFAULT_HEIGHT: u32 = 200;

fn clamp_height(h: u32) -> u32 {
    h.max(48).min(900)
}

fn snapshot(plugin_id: &str) -> Option<OverlayState> {
    table().lock().unwrap().get(plugin_id).copied()
}

fn place_above_pet(app: &AppHandle, label: &str) {
    let (Some(pet), Some(overlay)) = (app.get_webview_window("pet"), app.get_webview_window(label))
    else {
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

fn apply_visibility(app: &AppHandle, plugin_id: &str) {
    let Some(state) = snapshot(plugin_id) else { return };
    let label = overlay_label(plugin_id);
    let Some(win) = app.get_webview_window(&label) else {
        // 窗还没建（或已被页面自己关掉）：意愿留着，下次 show 再建
        return;
    };
    let show = state.wanted && !SUPPRESSED.load(Ordering::SeqCst);
    if show {
        let _ = win.show();
        if state.placement == PLACEMENT_ABOVE_PET {
            place_above_pet(app, &label);
        }
    } else {
        let _ = win.hide();
    }
    if state.visible != show {
        if let Some(entry) = table().lock().unwrap().get_mut(plugin_id) {
            entry.visible = show;
        }
    }
}

/// 宠物隐身/恢复时由宿主调用（见 window::pet::set_pet_hidden）：
/// 卡片贴在宠物身上或桌面上，宠物隐身时留着既难看又泄露信息，所以一起收掉；
/// 恢复时按各插件当时的意愿决定显不显示。
pub fn set_suppressed(app: &AppHandle, suppressed: bool) {
    SUPPRESSED.store(suppressed, Ordering::SeqCst);
    let ids: Vec<String> = table().lock().unwrap().keys().cloned().collect();
    for id in ids {
        apply_visibility(app, &id);
    }
}

fn ensure_window(app: &AppHandle, plugin_id: &str, height: u32) -> Result<(), String> {
    let label = overlay_label(plugin_id);
    if app.get_webview_window(&label).is_some() {
        let _ = app
            .get_webview_window(&label)
            .map(|win| win.set_size(PhysicalSize::new(WIDTH as u32, clamp_height(height))));
        return Ok(());
    }
    // 页面靠自己的窗口标签（overlay-<插件 id>）认卡片属于谁，不必再传查询串
    let win = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("overlay.html".into()),
    )
    // 标题带上插件 id：多扇悬浮窗在 CDP / 任务管理器里才分得清是谁的
    .title(format!("DesktopPet Overlay · {plugin_id}"))
    .position(24.0, 24.0)
    .inner_size(WIDTH, clamp_height(height) as f64)
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
    Ok(())
}

/// 插件 id 会进窗口标签，先过宿主既有的 id 规则
fn check_id(plugin_id: &str) -> Result<(), String> {
    if crate::commands::plugins::is_safe_id(plugin_id) {
        Ok(())
    } else {
        Err("非法的插件 id".into())
    }
}

/// 显示（或创建）本插件的悬浮层。placement 传 "above-pet" 时贴着宠物头顶并跟随拖动。
#[tauri::command]
pub async fn overlay_show(
    app: AppHandle,
    plugin_id: String,
    placement: Option<String>,
    height: Option<u32>,
) -> Result<(), String> {
    check_id(&plugin_id)?;
    let placement = if placement.as_deref() == Some("above-pet") {
        PLACEMENT_ABOVE_PET
    } else {
        PLACEMENT_CORNER
    };
    table().lock().unwrap().insert(
        plugin_id.clone(),
        OverlayState {
            placement,
            wanted: true,
            visible: false,
        },
    );
    ensure_window(&app, &plugin_id, height.unwrap_or(DEFAULT_HEIGHT))?;
    apply_visibility(&app, &plugin_id);
    Ok(())
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle, plugin_id: String) -> Result<(), String> {
    check_id(&plugin_id)?;
    if let Some(entry) = table().lock().unwrap().get_mut(&plugin_id) {
        entry.wanted = false;
    }
    apply_visibility(&app, &plugin_id);
    Ok(())
}

/// 插件停用/卸载时彻底销毁它自己的悬浮层，释放资源
#[tauri::command]
pub async fn overlay_destroy(app: AppHandle, plugin_id: String) -> Result<(), String> {
    check_id(&plugin_id)?;
    table().lock().unwrap().remove(&plugin_id);
    if let Some(win) = app.get_webview_window(&overlay_label(&plugin_id)) {
        let _ = win.close();
    }
    Ok(())
}

/// 当前有哪些悬浮层在显示（回归与诊断用）
#[tauri::command]
pub async fn overlay_list(app: AppHandle) -> Result<Vec<(String, bool, String)>, String> {
    let guard = table().lock().unwrap();
    Ok(guard
        .iter()
        .map(|(id, s)| {
            (
                id.clone(),
                s.visible && app.get_webview_window(&overlay_label(id)).is_some(),
                if s.placement == PLACEMENT_ABOVE_PET {
                    "above-pet".to_string()
                } else {
                    "corner".to_string()
                },
            )
        })
        .collect())
}

/// 贴着宠物的那些要跟随拖动。拖拽是 start_dragging 交给系统做的，宿主收不到移动事件，
/// 所以只能轮询位置 —— 且只在「实际显示且选择贴宠物」时才动，其他时候这个线程纯睡觉。
pub fn start_follow_timer(app: &AppHandle) {
    let sink = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        // 顺手清掉「窗已经没了、意愿也收了」的死条目
        table().lock().unwrap().retain(|id, s| {
            s.wanted || s.visible || sink.get_webview_window(&overlay_label(id)).is_some()
        });
        if SUPPRESSED.load(Ordering::SeqCst) {
            continue;
        }
        let targets: Vec<String> = match table().lock() {
            Ok(guard) => guard
                .iter()
                .filter(|(_, s)| s.visible && s.placement == PLACEMENT_ABOVE_PET)
                .map(|(id, _)| id.clone())
                .collect(),
            Err(_) => Vec::new(),
        };
        for id in targets {
            place_above_pet(&sink, &overlay_label(&id));
        }
    });
}
