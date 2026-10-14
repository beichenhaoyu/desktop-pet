use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::host_error::{HostError, DENIED, INTERNAL, INVALID_ARG, NOT_FOUND};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::services::permission::PermissionState;

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
///
/// `.` 编码成 `_` 而不是同样压成 `-`：插件 id 的字符集（见 commands::plugins::is_safe_id）
/// 里没有下划线，所以这个映射是单射。原先把两者都压成 `-` 会让 `a.b` 与 `a-b`
/// 撞进同一个标签，`owner_of_label` 按 HashMap 迭代序取第一个，归属就张冠李戴了。
pub fn overlay_label(plugin_id: &str) -> String {
    let cleaned: String = plugin_id
        .chars()
        .map(|c| {
            if c == '.' {
                '_'
            } else if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("overlay-{cleaned}")
}

pub(crate) fn owner_of_label(label: &str) -> Option<String> {
    let guard = table().lock().unwrap_or_else(|p| p.into_inner());
    guard.keys().find(|id| overlay_label(id) == label).cloned()
}

/// 悬浮窗页面问宿主「这扇窗是给谁的」——按调用者的窗口标签回答，前端伪造不了归属
#[tauri::command]
pub async fn overlay_owner(window: tauri::Window) -> Result<Option<String>, HostError> {
    Ok(owner_of_label(window.label()))
}

const WIDTH: f64 = 320.0;
const DEFAULT_HEIGHT: u32 = 200;

fn clamp_height(h: u32) -> u32 {
    h.clamp(48, 900)
}

fn snapshot(plugin_id: &str) -> Option<OverlayState> {
    table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(plugin_id)
        .copied()
}

fn place_above_pet(app: &AppHandle, label: &str) {
    let (Some(pet), Some(overlay)) = (app.get_webview_window("pet"), app.get_webview_window(label))
    else {
        return;
    };
    let Ok(pet_pos) = pet.outer_position() else {
        return;
    };
    let Ok(pet_size) = pet.outer_size() else {
        return;
    };
    let Ok(ov_size) = overlay.outer_size() else {
        return;
    };

    let gap: i32 = 8;
    let x = pet_pos.x + (pet_size.width as i32 - ov_size.width as i32) / 2;
    // 头顶放不下就贴到宠物下沿：「看得见」优先于「在上方」
    let y = pet_pos.y - ov_size.height as i32 - gap;
    let y = if y < 0 {
        pet_pos.y + pet_size.height as i32 + gap
    } else {
        y
    };
    let _ = overlay.set_position(PhysicalPosition::new(x, y));
}

fn apply_visibility(app: &AppHandle, plugin_id: &str) {
    let Some(state) = snapshot(plugin_id) else {
        return;
    };
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
        if let Some(entry) = table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(plugin_id)
        {
            entry.visible = show;
        }
    }
}

/// 宠物隐身/恢复时由宿主调用（见 window::pet::set_pet_hidden）：
/// 卡片贴在宠物身上或桌面上，宠物隐身时留着既难看又泄露信息，所以一起收掉；
/// 恢复时按各插件当时的意愿决定显不显示。
pub fn set_suppressed(app: &AppHandle, suppressed: bool) {
    SUPPRESSED.store(suppressed, Ordering::SeqCst);
    let ids: Vec<String> = table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .keys()
        .cloned()
        .collect();
    for id in ids {
        apply_visibility(app, &id);
    }
}

fn ensure_window(app: &AppHandle, plugin_id: &str, height: u32) -> Result<(), HostError> {
    let label = overlay_label(plugin_id);
    if app.get_webview_window(&label).is_some() {
        let _ = app
            .get_webview_window(&label)
            .map(|win| win.set_size(PhysicalSize::new(WIDTH as u32, clamp_height(height))));
        return Ok(());
    }
    // 页面靠自己的窗口标签（overlay-<插件 id>）认卡片属于谁，不必再传查询串
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("src/overlay.html".into()))
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
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
    // 悬浮层永远不拦截鼠标
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}

/// 插件 id 会进窗口标签，先过宿主既有的 id 规则
fn check_id(plugin_id: &str) -> Result<(), HostError> {
    if crate::ids::is_safe_id(plugin_id) {
        Ok(())
    } else {
        Err(HostError::new(INVALID_ARG, "非法的插件 id"))
    }
}

/// S3：悬浮层是插件的脸面，也得按能力放行。以前只有 JS 桥 `ctx.overlay` 上的 gated
/// 一层在挡，绕过桥的插件可以凭空开一扇置顶透明窗，既不消耗配额也不留授权记录。
/// 同 realm 的插件冒名他人 id 仍拦不住（见 gate.rs）。
fn check_grant(perms: &PermissionState, plugin_id: &str) -> Result<(), HostError> {
    check_id(plugin_id)?;
    crate::gate::plugin_capability(perms, plugin_id, crate::plugin_caps::OVERLAY)
}

/// 收掉某插件的悬浮层（移出注册表 + 关窗）。
/// 命令面与宿主内部回收共用这一份，差别只在调用前要过谁的门禁。
fn reclaim(app: &AppHandle, plugin_id: &str) {
    table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(plugin_id);
    if let Some(win) = app.get_webview_window(&overlay_label(plugin_id)) {
        let _ = win.close();
    }
}

/// 宿主内部的回收（撤销授权时调用）：那时能力已经没了，走不了命令面的门禁
pub fn reclaim_for_permission(app: &AppHandle, plugin_id: &str) {
    reclaim(app, plugin_id);
}

/// 迁移期简写：窗口归属判定的拒绝（文案一字不改，只补码 —— ADR-0007）
fn denied(msg: String) -> HostError {
    HostError::new(DENIED, msg)
}

/// 谁能代表某个插件动它的悬浮层：宠物窗（运行时与插件同 realm）、设置窗（插件设置页）、
/// 以及该插件自己那扇悬浮窗 —— 后者的归属由注册表判定，页面自报的 id 在这一路不算。
fn caller_may_act_for(label: &str, plugin_id: &str) -> bool {
    label == "pet" || label == "settings" || owner_of_label(label).as_deref() == Some(plugin_id)
}

/// 显示（或创建）本插件的悬浮层。placement 传 "above-pet" 时贴着宠物头顶并跟随拖动。
#[tauri::command]
pub async fn overlay_show(
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    window: tauri::Window,
    plugin_id: String,
    placement: Option<String>,
    height: Option<u32>,
) -> Result<(), HostError> {
    check_grant(&perms, &plugin_id)?;
    if !caller_may_act_for(window.label(), &plugin_id) {
        return Err(denied(format!(
            "窗口 {} 不能为插件 {plugin_id} 开悬浮层",
            window.label()
        )));
    }
    require_installed(&app, &plugin_id)?;
    mark_wanted(&plugin_id, resolve_placement(placement.as_deref()));
    ensure_window(&app, &plugin_id, height.unwrap_or(DEFAULT_HEIGHT))?;
    apply_visibility(&app, &plugin_id);
    Ok(())
}

/// placement 的取值规则（ADR-0005：规则抽成纯函数好离线钉住）——
/// 只有显式的 "above-pet" 才贴宠物头顶，`None` 与任何未知写法都走角落，不做模糊匹配。
fn resolve_placement(requested: Option<&str>) -> u8 {
    if requested == Some("above-pet") {
        PLACEMENT_ABOVE_PET
    } else {
        PLACEMENT_CORNER
    }
}

/// 只为确实装着的插件开窗：凭空的 id 会留下一扇没人认领、也没人能收掉的窗
/// （插件之间的越权仍拦不住，那是自报 plugin_id 的固有问题，见 gate.rs 与 R2）
fn require_installed(app: &AppHandle, plugin_id: &str) -> Result<(), HostError> {
    let installed = crate::commands::plugins::installed_plugin_ids(app)
        .map(|ids| ids.iter().any(|id| id == plugin_id))
        .unwrap_or(false);
    if installed {
        Ok(())
    } else {
        Err(HostError::new(
            NOT_FOUND,
            format!("插件 {plugin_id} 没有安装，不能开悬浮层"),
        ))
    }
}

/// 记下「这个插件想要一扇什么位置的窗」。新建的状态一律 `visible: false`，
/// 由 `apply_visibility` 按当前压制状态决定要不要真的显示出来。
fn mark_wanted(plugin_id: &str, placement: u8) {
    table().lock().unwrap_or_else(|p| p.into_inner()).insert(
        plugin_id.to_string(),
        OverlayState {
            placement,
            wanted: true,
            visible: false,
        },
    );
}

#[tauri::command]
pub async fn overlay_hide(
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    window: tauri::Window,
    plugin_id: String,
) -> Result<(), HostError> {
    check_grant(&perms, &plugin_id)?;
    if !caller_may_act_for(window.label(), &plugin_id) {
        return Err(denied(format!(
            "窗口 {} 不能收起插件 {plugin_id} 的悬浮层",
            window.label()
        )));
    }
    if let Some(entry) = table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(&plugin_id)
    {
        entry.wanted = false;
    }
    apply_visibility(&app, &plugin_id);
    Ok(())
}

/// 插件主动销毁自己那扇悬浮层，释放资源
#[tauri::command]
pub async fn overlay_destroy(
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    window: tauri::Window,
    plugin_id: String,
) -> Result<(), HostError> {
    check_grant(&perms, &plugin_id)?;
    if !caller_may_act_for(window.label(), &plugin_id) {
        return Err(denied(format!(
            "窗口 {} 不能销毁插件 {plugin_id} 的悬浮层",
            window.label()
        )));
    }
    reclaim(&app, &plugin_id);
    Ok(())
}

/// 宿主的回收通道（宠物窗里的运行时在插件停用/卸载时调用）：
/// 撤销授权会把能力收走，那时插件面的门禁已经过不去，窗却还留着 —— 等于泄露信息。
#[tauri::command]
pub async fn overlay_reclaim(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: String,
) -> Result<(), HostError> {
    crate::gate::pet(&window, "回收插件悬浮层")?;
    check_id(&plugin_id)?;
    reclaim(&app, &plugin_id);
    Ok(())
}

/// 当前有哪些悬浮层在显示（回归与诊断用）
#[tauri::command]
pub async fn overlay_list(app: AppHandle) -> Result<Vec<(String, bool, String)>, HostError> {
    let guard = table().lock().unwrap_or_else(|p| p.into_inner());
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
        table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|id, s| {
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

#[cfg(test)]
mod tests {
    use super::{
        caller_may_act_for, mark_wanted, overlay_label, resolve_placement, table, OverlayState,
        PLACEMENT_ABOVE_PET, PLACEMENT_CORNER,
    };

    #[test]
    fn dots_and_hyphens_do_not_share_a_label() {
        assert_eq!(overlay_label("com.pet.hr-ble"), "overlay-com_pet_hr-ble");
        // 早先两者都压成 `-`，a.b 与 a-b 会抢同一扇窗，归属按迭代序乱认
        assert_ne!(overlay_label("a.b"), overlay_label("a-b"));
    }

    #[test]
    fn labels_stay_inside_the_tauri_charset() {
        for id in ["todo", "com.pet.hr-ble", "zz.probe", "a1.2-3"] {
            let label = overlay_label(id);
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
                "{label} 含非法字符"
            );
        }
    }

    /// S3：动得了悬浮层的只有三类调用面 —— 宠物窗、设置窗、以及该插件自己那扇窗。
    /// 「自己那扇」的归属来自注册表，不是来自页面自报的 id。
    #[test]
    fn only_host_windows_or_the_own_overlay_may_act_for_a_plugin() {
        let id = "com.pet.hr-ble".to_string();
        table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), OverlayState::default());
        let label = overlay_label(&id);
        assert!(caller_may_act_for("pet", &id));
        assert!(caller_may_act_for("settings", &id));
        assert!(caller_may_act_for(&label, &id));
        // 别人的悬浮窗里动不了这扇（归属不匹配）
        assert!(!caller_may_act_for(&label, "todo"));
        // 同意框一类窗口既不是宿主窗，也不属于这个插件
        assert!(!caller_may_act_for("consent-r1", &id));
        table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    /// ADR-0005：placement 取值规则抽出命令体后逐条钉住——只有显式 "above-pet" 贴头顶
    #[test]
    fn placement_only_honours_the_exact_above_pet_keyword() {
        assert_eq!(resolve_placement(Some("above-pet")), PLACEMENT_ABOVE_PET);
        assert_eq!(resolve_placement(None), PLACEMENT_CORNER, "不传就走角落");
        assert_eq!(
            resolve_placement(Some("Above-Pet")),
            PLACEMENT_CORNER,
            "大小写不凑对"
        );
        assert_eq!(
            resolve_placement(Some("")),
            PLACEMENT_CORNER,
            "空串按未知处理"
        );
    }

    #[test]
    fn mark_wanted_records_placement_and_starts_unseen() {
        let id = "zz.shape-probe";
        mark_wanted(id, PLACEMENT_ABOVE_PET);
        let state = table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned();
        table().lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        let state = state.expect("mark_wanted 该留下一条状态");
        assert_eq!(state.placement, PLACEMENT_ABOVE_PET, "位置要按传进来的记");
        assert!(state.wanted, "调用即表示这个插件想要一扇窗");
        assert!(
            !state.visible,
            "可见性交给 apply_visibility，不在这里预先置真"
        );
    }

    /// A2 / ADR-0007：overlay_list 体内没有错误产生点（一条 `?` 都没有），签名照样要改 ——
    /// 在源码文本层钉住（命令函数不能取符号，会把 tauri 命令机制拉进测试 exe 链接，A03 实测）。
    /// 期望串用 concat! 拆两段：本测试就在被 include_str! 读的文件里，
    /// 整串写字面量的话断言会匹配到自己、恒真。拆开后任何一段都不是完整签名。
    #[test]
    fn overlay_list_signature_declares_host_error() {
        let flat = include_str!("overlay.rs")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            flat.contains(concat!(
                "pub async fn overlay_list(app: AppHandle) -> Result<Vec<(String, bool, String)>",
                ", HostError> {"
            )),
            "overlay_list 的 Err 侧必须是 HostError"
        );
    }
}
