use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 显示（或创建）左上角 overlay 悬浮层：透明、置顶、点击穿透、不进任务栏。
/// 全屏游戏时叠加显示，且不拦截任何鼠标操作（不影响游戏进程）。
#[tauri::command]
pub async fn overlay_show(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.show();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("DesktopPet Overlay")
        .position(24.0, 24.0)
        .inner_size(320.0, 200.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;
    // 悬浮层永远不拦截鼠标
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    Ok(())
}

/// 插件停用/卸载时彻底销毁 overlay，释放资源
#[tauri::command]
pub async fn overlay_destroy(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }
    Ok(())
}
