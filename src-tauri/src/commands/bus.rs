use tauri::{AppHandle, Emitter};

/// 跨窗口事件总线中继：任意窗口的 publish 广播到全部窗口，
/// 各窗口前端按 origin 去重后派发到本地订阅者。
#[tauri::command]
pub fn bus_publish(app: AppHandle, origin: String, topic: String, payload: serde_json::Value) {
    let _ = app.emit("bus", serde_json::json!({ "origin": origin, "topic": topic, "payload": payload }));
}
