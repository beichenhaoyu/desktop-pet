mod commands;
mod services;
mod window;

use services::{ble::BleState, http::HttpState, permission::PermissionState, store::StoreState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 插件文件协议必须在窗口创建前注册
    let builder = commands::plugins::register_plugin_protocol(tauri::Builder::default());
    builder
        // 单实例必须最先注册：重复启动时唤起已有宠物窗
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.show();
                let _ = pet.unminimize();
                let _ = pet.set_focus();
            }
        }))
        // 宿主侧日志：此前所有失败都被 `let _ =` 吞掉，出错时毫无线索
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("host".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        // 系统通知：只给宿主 Rust 侧调用，插件必须经 notify_show 的授权检查
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(StoreState::new());
            app.manage(PermissionState::new());
            app.manage(BleState::new());
            app.manage(HttpState::new());
            app.state::<StoreState>().init(app.handle())?;
            app.state::<PermissionState>().init(app.handle())?;
            window::pet::setup(app.handle())?;
            window::tray::setup(app.handle())?;
            // watcher 被 drop 就停止监听，所以必须交给 app state 长期持有
            let watcher = commands::plugins::spawn_plugins_watcher(app.handle())?;
            app.manage(std::sync::Mutex::new(watcher));
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
            services::http::http_request,
            services::notify::notify_show,
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
