use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// 系统托盘：左键切换宠物显隐，右键菜单（显隐 / 设置 / 退出）
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏宠物", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &quit])?;

    let mut builder = TrayIconBuilder::with_id("pet-tray")
        .tooltip("DesktopPet")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_pet(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_pet(app),
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        });
    // 图标缺失就按系统默认图标建托盘，不该因为一个资源没打进去而启动即崩
    match app.default_window_icon() {
        Some(icon) => builder = builder.icon(icon.clone()),
        None => log::warn!("[tray] 没有默认窗口图标，托盘使用系统默认图标"),
    }
    builder.build(app)?;
    Ok(())
}

fn toggle_pet(app: &AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        if pet.is_visible().unwrap_or(false) {
            let _ = pet.hide();
        } else {
            let _ = pet.show();
            let _ = pet.set_focus();
        }
    }
}

/// 打开（或唤起）设置窗。托盘菜单与回归脚本共用这一个入口。
#[tauri::command]
pub async fn settings_show(window: tauri::Window, app: AppHandle) -> Result<(), String> {
    // 只让宠物窗请求：插件页面不该有把设置窗弹出来的能力
    crate::gate::pet(&window, "打开设置窗")?;
    open_settings(&app);
    Ok(())
}

/// 打开（或唤起）设置窗。托盘菜单、全局快捷键与回归脚本共用这一个入口。
pub fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("DesktopPet 设置")
        .inner_size(760.0, 600.0)
        .min_inner_size(660.0, 460.0)
        .resizable(true)
        .build();
}
