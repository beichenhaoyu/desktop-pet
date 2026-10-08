use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use tauri::Emitter;

/// 跨窗口事件总线中继：任意窗口的 publish 广播到全部窗口，
/// 各窗口前端按 origin 去重后派发到本地订阅者。
/// origin 由宿主按实际调用窗口判定，前端无法伪造或抑制对他窗的投递。
#[tauri::command]
pub fn bus_publish(window: tauri::Window, topic: String, payload: serde_json::Value) {
    if is_widget_topic(&topic) {
        remember(&topic, &payload);
    }
    let _ = window.emit(
        "bus",
        serde_json::json!({ "origin": window.label(), "topic": topic, "payload": payload }),
    );
}

/// 插件给自己界面（badge / overlay / settings）看的展示数据，统一走 `<id>:widget`
fn is_widget_topic(topic: &str) -> bool {
    topic.ends_with(":widget")
}

static RETAINED: OnceLock<Mutex<(HashMap<String, serde_json::Value>, VecDeque<String>)>> =
    OnceLock::new();

/// 只留最近这些 topic，防止某个插件刷屏把内存变成无界缓冲
const MAX_RETAINED: usize = 32;

fn retained() -> &'static Mutex<(HashMap<String, serde_json::Value>, VecDeque<String>)> {
    RETAINED.get_or_init(|| Mutex::new((HashMap::new(), VecDeque::new())))
}

fn remember(topic: &str, payload: &serde_json::Value) {
    let mut guard = retained().lock().unwrap_or_else(|p| p.into_inner());
    if !guard.0.contains_key(topic) {
        guard.1.push_back(topic.to_string());
        while guard.1.len() > MAX_RETAINED {
            if let Some(old) = guard.1.pop_front() {
                guard.0.remove(&old);
            }
        }
    }
    guard.0.insert(topic.to_string(), payload.clone());
}

/// 界面刚挂上来时问宿主「这个 topic 现在该显示什么」。
///
/// 没有这一步的话，设置面板重新打开只会渲染自己的默认值：用户一碰开关，
/// 面板就把没碰过的那个也按默认值写回去，表现成「配置根本没保存」。
/// 只回 `*:widget`（插件给自己界面看的展示数据），cmd / status / devices
/// 这类指令与中间态一律不回。
#[tauri::command]
pub fn bus_peek(window: tauri::Window, topic: String) -> Option<serde_json::Value> {
    let label = window.label().to_string();
    let hosts_widgets = label == "settings" || label == "pet" || label.starts_with("overlay-");
    if !hosts_widgets || !is_widget_topic(&topic) {
        return None;
    }
    retained().lock().unwrap_or_else(|p| p.into_inner()).0.get(&topic).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_widget_topics_are_retained() {
        assert!(is_widget_topic("com.pet.hr-ble:widget"));
        assert!(!is_widget_topic("com.pet.hr-ble:cmd"));
        assert!(!is_widget_topic("com.pet.hr-ble:status"));
    }

    #[test]
    fn retention_keeps_only_the_latest_per_topic() {
        remember("t:widget", &serde_json::json!({ "v": 1 }));
        remember("t:widget", &serde_json::json!({ "v": 2 }));
        let guard = retained().lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(guard.0.get("t:widget").unwrap()["v"], 2);
        assert_eq!(guard.1.iter().filter(|k| k.as_str() == "t:widget").count(), 1);
    }

    #[test]
    fn retention_is_capped() {
        for i in 0..(MAX_RETAINED + 10) {
            remember(&format!("cap{i}:widget"), &serde_json::json!(i));
        }
        let guard = retained().lock().unwrap_or_else(|p| p.into_inner());
        assert!(guard.0.len() <= MAX_RETAINED, "实际留下 {}", guard.0.len());
        assert!(!guard.0.contains_key("cap0:widget"), "最早的应当被挤掉");
        assert!(guard.0.contains_key(&format!("cap{}:widget", MAX_RETAINED + 9)));
    }
}
