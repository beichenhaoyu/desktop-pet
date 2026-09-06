use tauri::{AppHandle, Manager, PhysicalPosition};

/// 宠物窗初始化：默认摆放到主屏右下角
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let pet = app
        .get_webview_window("pet")
        .expect("pet window must be defined in tauri.conf.json");

    let monitor = match pet.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => pet.primary_monitor().ok().flatten(),
    };
    if let Some(monitor) = monitor {
        let win = pet.outer_size()?;
        let m = monitor.size();
        let pos = monitor.position();
        // 贴着任务栏上沿摆放（任务栏默认约 48 逻辑像素高）
        let scale = pet.scale_factor().unwrap_or(1.0);
        let margin = (52.0 * scale) as i32;
        let x = pos.x + m.width as i32 - win.width as i32 - margin;
        let y = pos.y + m.height as i32 - win.height as i32 - margin;
        pet.set_position(PhysicalPosition::new(x.max(pos.x), y.max(pos.y)))?;
    }
    Ok(())
}

/// 切换点击穿透：开启后鼠标事件落到宠物下方的窗口
#[tauri::command]
pub fn set_click_through(window: tauri::Window, enabled: bool) {
    let _ = window.set_ignore_cursor_events(enabled);
}

/// 退出应用（托盘「退出」使用）
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
