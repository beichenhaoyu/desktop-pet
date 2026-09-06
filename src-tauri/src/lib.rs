mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：重复启动时唤起已有宠物窗
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.show();
                let _ = pet.unminimize();
                let _ = pet.set_focus();
            }
        }))
        .setup(|app| {
            window::pet::setup(app.handle())?;
            window::tray::setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::pet::set_click_through,
            window::pet::quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
