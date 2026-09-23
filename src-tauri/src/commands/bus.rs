use tauri::Emitter;

/// 跨窗口事件总线中继：任意窗口的 publish 广播到全部窗口，
/// 各窗口前端按 origin 去重后派发到本地订阅者。
/// origin 由宿主按实际调用窗口判定，前端无法伪造或抑制对他窗的投递。
#[tauri::command]
pub fn bus_publish(window: tauri::Window, topic: String, payload: serde_json::Value) {
    let _ = window.emit(
        "bus",
        serde_json::json!({ "origin": window.label(), "topic": topic, "payload": payload }),
    );
}
