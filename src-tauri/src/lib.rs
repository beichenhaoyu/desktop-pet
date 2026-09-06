mod commands;
mod services;
mod window;

use services::{ble::BleState, permission::PermissionState, store::StoreState};
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
            app.manage(StoreState::new());
            app.manage(PermissionState::new());
            app.manage(BleState::new());
            app.state::<StoreState>().init(app.handle());
            app.state::<PermissionState>().init(app.handle());
            window::pet::setup(app.handle())?;
            window::tray::setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::pet::set_click_through,
            window::pet::quit_app,
            window::overlay::overlay_show,
            window::overlay::overlay_hide,
            window::overlay::overlay_destroy,
            commands::plugins::plugins_list,
            commands::bus::bus_publish,
            services::store::store_get,
            services::store::store_set,
            services::store::store_delete,
            services::permission::permission_check,
            services::permission::permission_request,
            services::permission::consent_details,
            services::permission::consent_answer,
            services::permission::permission_list,
            services::permission::permission_revoke,
            services::ble::ble_start_scan,
            services::ble::ble_stop_scan,
            services::ble::ble_connect,
            services::ble::ble_disconnect,
            services::ble::ble_connected_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
