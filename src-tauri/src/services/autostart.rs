// 开机自启。用官方插件写/读 HKCU 的 Run 键，宿主只暴露两个命令给设置窗。
//
// 值得注意的一点：注册进去的是 `current_exe()` 的路径。dev 下那是
// `src-tauri/target/debug/desktop-pet.exe`，拿它开机自启没有意义还会误导人，
// 所以状态里把实际路径一起回给前端，由界面提示「当前是开发实例」。
use serde::Serialize;
use tauri_plugin_autostart::ManagerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub enabled: bool,
    /// 自启会拉起的那个 exe；dev 构建指向 target/debug，界面上要如实显示
    pub exe: String,
    pub dev_build: bool,
}

// 插件 v2 的扩展方法仍叫 `autolaunch()`（改名为 autostart 排到了 v3），
// 所以这里统一走 app.autolaunch()，别照着新文档找方法。
fn manager(app: &tauri::AppHandle) -> tauri::State<'_, tauri_plugin_autostart::AutoLaunchManager> {
    app.autolaunch()
}

fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn autostart_status(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    let exe = exe_path();
    Ok(AutostartStatus {
        enabled: manager(&app).is_enabled().map_err(|e| e.to_string())?,
        dev_build: exe.contains("\\target\\") || exe.contains("/target/"),
        exe,
    })
}

/// 只允许设置窗改：这是会跨会话生效的系统级开关
#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, window: tauri::Window, enabled: bool) -> Result<bool, String> {
    crate::gate::settings(&window, "改动开机自启")?;
    let starter = manager(&app);
    if enabled {
        starter.enable().map_err(|e| e.to_string())?;
    } else {
        starter.disable().map_err(|e| e.to_string())?;
    }
    starter.is_enabled().map_err(|e| e.to_string())
}
