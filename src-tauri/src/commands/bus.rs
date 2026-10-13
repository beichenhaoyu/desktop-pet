use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::services::permission::PermissionState;

/// 跨窗口事件总线中继：任意窗口的 publish 广播到全部窗口，
/// 各窗口前端按 origin 去重后派发到本地订阅者。
/// origin 由宿主按实际调用窗口判定，前端无法伪造或抑制对他窗的投递。
///
/// S2：topic 归属与能力授权同样收在 Rust 侧。以前 JS 桥之上的 `assertPublishable`
/// 是唯一的关口，绕过桥的插件可以往 `agent:state`、`ble:heart-rate` 这类宿主 topic
/// 或他人前缀里灌数据，全桌面的窗口都会收到。
/// 拦不住的仍是「同 realm 的插件冒名他人 id」—— 那要等 Web Worker 宿主。
#[tauri::command]
pub fn bus_publish(
    window: tauri::Window,
    app: AppHandle,
    perms: tauri::State<PermissionState>,
    topic: String,
    payload: serde_json::Value,
    plugin_id: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    // 悬浮窗的归属只认宿主注册表：那条 label 是开窗时宿主自己定的，页面伪造不了，
    // 所以这一路不接受客户端自报的 plugin_id
    let owner = crate::window::overlay::owner_of_label(&label).or_else(|| {
        if relaying_from(&label) {
            plugin_id
        } else {
            None
        }
    });
    let installed: HashSet<String> = crate::commands::plugins::installed_plugin_ids(&app)
        .map(|ids| ids.into_iter().collect())
        .unwrap_or_default();
    check_publish(&label, owner.as_deref(), &topic, &installed, &|id, cap| {
        perms.is_granted(id, cap)
    })?;

    if is_widget_topic(&topic) {
        remember(&topic, &payload);
    }
    let _ = app.emit(
        "bus",
        serde_json::json!({ "origin": label, "topic": topic, "payload": payload }),
    );
    Ok(())
}

/// 只有这三类窗口能往总线灌数据：宠物窗（运行时与插件同 realm）、
/// 设置窗（插件设置页）、悬浮窗（`overlay-<id>`）。同意框一类的窗口不在此列。
fn relaying_from(label: &str) -> bool {
    label == "pet" || label == "settings" || label.starts_with("overlay-")
}

/// 判定表单独成函数，好让「谁的什么 topic 要不要什么能力」这套规则有离线单测。
fn check_publish(
    label: &str,
    owner: Option<&str>,
    topic: &str,
    installed: &HashSet<String>,
    is_granted: &dyn Fn(&str, &str) -> bool,
) -> Result<(), String> {
    if !relaying_from(label) {
        return Err(format!("窗口 {label} 不能发布总线 topic"));
    }
    let Some(id) = owner else {
        return Err("发布总线需要 pluginId：topic 归属由它判定".into());
    };
    if !crate::ids::is_safe_id(id) {
        return Err("invalid plugin id".into());
    }
    if !installed.contains(id) {
        return Err(format!("插件 {id} 没有安装，不能发布它的 topic"));
    }
    if !topic.starts_with(&format!("{id}:")) || topic == format!("{id}:") {
        return Err(format!(
            "只能发布 \"{id}:\" 前缀的 topic，收到的是 \"{topic}\""
        ));
    }
    // `<id>:widget` 是插件给自己界面看的展示数据，桥那边 gated 在 widget 能力上，
    // 所以两条能力任一成立即放行（其余 topic 只认 bus:publish）
    let allowed = is_granted(id, crate::plugin_caps::BUS_PUBLISH)
        || (topic == format!("{id}:widget") && is_granted(id, crate::plugin_caps::WIDGET));
    if !allowed {
        return Err(format!(
            "未授权 bus:publish：{id} 需要 manifest 声明且已同意"
        ));
    }
    Ok(())
}

/// 插件给自己界面（badge / overlay / settings）看的展示数据，统一走 `<id>:widget`
fn is_widget_topic(topic: &str) -> bool {
    topic.ends_with(":widget")
}

/// 最近一份 `*:widget` 数据 + 写入顺序（用来按上限挤掉最旧的 topic）
type Retained = Mutex<(HashMap<String, serde_json::Value>, VecDeque<String>)>;

static RETAINED: OnceLock<Retained> = OnceLock::new();

/// 只留最近这些 topic，防止某个插件刷屏把内存变成无界缓冲
const MAX_RETAINED: usize = 32;

fn retained() -> &'static Retained {
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
    retained()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .0
        .get(&topic)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> HashSet<String> {
        ["todo".to_string(), "com.pet.astock".to_string()]
            .into_iter()
            .collect()
    }

    /// 授权表替身：只有列出来的 (id, cap) 算已授权
    fn grant(list: &[(&str, &str)]) -> impl Fn(&str, &str) -> bool {
        let set: HashSet<(String, String)> = list
            .iter()
            .map(|(i, c)| (i.to_string(), c.to_string()))
            .collect();
        move |id, cap| set.contains(&(id.to_string(), cap.to_string()))
    }

    #[test]
    fn own_prefix_with_grant_is_allowed() {
        let g = grant(&[("todo", "bus:publish")]);
        assert!(check_publish("pet", Some("todo"), "todo:changed", &installed(), &g).is_ok());
        // 设置页与悬浮窗同理（悬浮窗的归属由调用方按注册表解析好）
        assert!(check_publish("settings", Some("todo"), "todo:cmd", &installed(), &g).is_ok());
        assert!(check_publish("overlay-todo", Some("todo"), "todo:cmd", &installed(), &g).is_ok(),);
    }

    /// 这是 S2 的正身：绕过 JS 桥直接 invoke 也灌不进别人的、更灌不进宿主的 topic
    #[test]
    fn foreign_and_host_topics_are_rejected() {
        let g = grant(&[("todo", "bus:publish"), ("com.pet.astock", "bus:publish")]);
        for topic in [
            "com.pet.astock:cmd",
            "ble:heart-rate",
            "agent:state",
            "agent:event",
            "host:fullscreen",
            "todo:",
        ] {
            let err = check_publish("pet", Some("todo"), topic, &installed(), &g).unwrap_err();
            assert!(err.contains("前缀"), "{topic} 的错误口径不对: {err}");
        }
    }

    #[test]
    fn without_grant_the_publish_is_rejected() {
        let g = grant(&[]);
        let err = check_publish("pet", Some("todo"), "todo:changed", &installed(), &g).unwrap_err();
        assert!(err.contains("未授权 bus:publish"), "实际: {err}");
    }

    #[test]
    fn widget_topic_accepts_the_widget_capability() {
        let g = grant(&[("todo", "widget")]);
        assert!(check_publish("pet", Some("todo"), "todo:widget", &installed(), &g).is_ok());
        // 但 widget 能力不能拿去发别的 topic
        assert!(check_publish("pet", Some("todo"), "todo:cmd", &installed(), &g).is_err());
    }

    #[test]
    fn caller_must_be_a_known_plugin_in_a_relaying_window() {
        let g = grant(&[("todo", "bus:publish")]);
        // 没有 plugin_id：归属无从判定
        assert!(check_publish("pet", None, "todo:changed", &installed(), &g).is_err());
        // 没装着的插件（含冒用他人 id 的字面量）
        assert!(check_publish("pet", Some("zz.gone"), "zz.gone:cmd", &installed(), &g).is_err());
        // 非法 id 先于授权被拒
        assert!(check_publish("pet", Some("C:"), "C:x", &installed(), &g).is_err());
        // 同意框与其它窗口不在发布名单里
        assert!(
            check_publish("consent-r1", Some("todo"), "todo:changed", &installed(), &g).is_err()
        );
        assert!(check_publish("main", Some("todo"), "todo:changed", &installed(), &g).is_err());
    }

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
        assert_eq!(
            guard.1.iter().filter(|k| k.as_str() == "t:widget").count(),
            1
        );
    }

    #[test]
    fn retention_is_capped() {
        for i in 0..(MAX_RETAINED + 10) {
            remember(&format!("cap{i}:widget"), &serde_json::json!(i));
        }
        let guard = retained().lock().unwrap_or_else(|p| p.into_inner());
        assert!(guard.0.len() <= MAX_RETAINED, "实际留下 {}", guard.0.len());
        assert!(!guard.0.contains_key("cap0:widget"), "最早的应当被挤掉");
        assert!(guard
            .0
            .contains_key(&format!("cap{}:widget", MAX_RETAINED + 9)));
    }
}
