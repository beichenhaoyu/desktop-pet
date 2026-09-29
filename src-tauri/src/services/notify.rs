use tauri_plugin_notification::NotificationExt;

use super::permission::PermissionState;

/// 系统通知。同样过授权表，否则任何插件都能拿它骚扰用户。
#[tauri::command]
pub fn notify_show(
    app: tauri::AppHandle,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    if !crate::commands::plugins::is_safe_id(&plugin_id) {
        return Err("invalid plugin id".into());
    }
    if !perms.is_granted(&plugin_id, "notify") {
        return Err("未授权发送系统通知：需要 manifest 声明 notify 并已同意".into());
    }
    let title = sanitize(&title, 80);
    let text = sanitize(&body, 240);
    if title.is_empty() && text.is_empty() {
        return Err("通知内容为空".into());
    }
    app.notification()
        .builder()
        .title(&title)
        .body(&text)
        .show()
        .map_err(|e| e.to_string())
}

/// 压掉换行并限长：通知气泡不接受插件塞进来的多行长文
fn sanitize(input: &str, max_chars: usize) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}
