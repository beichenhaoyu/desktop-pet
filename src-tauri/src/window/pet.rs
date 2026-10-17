use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::host_error::{HostError, INTERNAL};

/// 宠物窗初始化：默认摆放到主屏右下角
pub fn setup(app: &AppHandle) -> Result<(), String> {
    // 配置里没定义 pet 窗是启动期错误，不该 panic（宿主以 panic=abort 构建）
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| "tauri.conf.json 未定义 pet 窗口".to_string())?;

    let monitor = match pet.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => pet.primary_monitor().ok().flatten(),
    };
    if let Some(monitor) = monitor {
        let win = pet.outer_size().map_err(|e| e.to_string())?;
        let m = monitor.size();
        let pos = monitor.position();
        // 贴着任务栏上沿摆放（任务栏默认约 48 逻辑像素高）
        let scale = pet.scale_factor().unwrap_or(1.0);
        let margin = (52.0 * scale) as i32;
        let x = pos.x + m.width as i32 - win.width as i32 - margin;
        let y = pos.y + m.height as i32 - win.height as i32 - margin;
        pet.set_position(PhysicalPosition::new(x.max(pos.x), y.max(pos.y)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 切换点击穿透：开启后鼠标事件落到宠物下方的窗口。
/// 唯一调用者是宠物窗自己的轮询（src/pet/click-through.ts），所以门禁就是 gate::pet ——
/// 这条以前是**全项目唯一没有门禁**的命令，任意窗口（含绕过 JS 桥的插件）都能让宠物窗穿透。
/// 顺带把 `let _ =` 吞错改成如实返回（ADR-0007 的形状）。
#[tauri::command]
pub fn set_click_through(window: tauri::Window, enabled: bool) -> Result<(), HostError> {
    crate::gate::pet(&window, "切换点击穿透")?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))
}

/// 游戏模式的隐身开关：宠物窗与贴在它身上的悬浮 UI（overlay 单窗）一起收放。
/// 这件事放在宿主而不是各插件自己处理，是因为只有宿主知道全貌 ——
/// 各藏各的会出现「宠物消失了，心率波形图还孤零零浮在全屏游戏上」。
#[tauri::command]
pub async fn set_pet_hidden(
    window: tauri::Window,
    app: AppHandle,
    hidden: bool,
) -> Result<(), HostError> {
    // 只有宠物窗自己能隐身：绕过 JS 桥直接 invoke 的插件不该能把宠物和它的 UI 一起藏掉
    crate::gate::pet(&window, "触发隐身")?;
    if let Some(pet) = app.get_webview_window("pet") {
        if hidden {
            pet.hide()
                .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
        } else {
            pet.show()
                .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
        }
    }
    // 层内相对次序只由 `set_suppressed` 里的逐扇重放负责（ADR-0010 修订 2026-10-16：
    // 这里原来还有一次整体重放，三态实测证明在同一条路径上是重复保险，已删）
    super::overlay::set_suppressed(&app, hidden);
    Ok(())
}
