//! 窗口来源门禁：命令由哪个窗口发来，决定它能不能改宿主。
//!
//! 判定只看 `window.label()` —— 那是宿主自己建窗时定的，前端伪造不了。
//! 插件 JS 就跑在宠物窗里，所以这条门禁拦得住「绕过 JS 桥直接 invoke」的插件越权；
//! 拦不住的是宠物窗内插件之间的区分（同 realm，宿主看不出是哪个插件），
//! 那要等 Web Worker 宿主才收口（见 ARCHITECTURE.md 信任模型）。
use tauri::Window;

use crate::services::permission::PermissionState;

/// 跨会话生效的系统级开关、授权表、形象与 hook 配置：只认设置窗
pub fn settings(window: &Window, what: &str) -> Result<(), String> {
    require(window.label(), "settings", "设置窗", what)
}

/// 影响宠物本体显隐与宿主窗口自身的动作：只认宠物窗
pub fn pet(window: &Window, what: &str) -> Result<(), String> {
    require(window.label(), "pet", "宠物窗", what)
}

/// 插件调用面的第二道门：命令带 `pluginId` 时，除窗口门禁外还要该能力已授权。
/// 与 BLE 命令的 `require_granted` 同一口径（兜的是「绕过 JS 桥直接 invoke」）；
/// 同 realm 的插件之间仍分不出，那条缺口要等 Web Worker 宿主。
pub fn plugin_capability(state: &PermissionState, plugin_id: &str, capability: &str) -> Result<(), String> {
    if !crate::commands::plugins::is_safe_id(plugin_id) {
        return Err("invalid plugin id".into());
    }
    if state.is_granted(plugin_id, capability) {
        Ok(())
    } else {
        Err(format!("未授权 {capability}：需要 manifest 声明且已同意"))
    }
}

fn require(label: &str, expected: &str, name: &str, what: &str) -> Result<(), String> {
    if label == expected {
        Ok(())
    } else {
        Err(format!("只有{name}可以{what}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{plugin_capability, require};
    use crate::services::permission::PermissionState;

    #[test]
    fn only_the_named_window_passes() {
        assert!(require("settings", "settings", "设置窗", "改动开机自启").is_ok());
        assert_eq!(
            require("pet", "settings", "设置窗", "改动开机自启").unwrap_err(),
            "只有设置窗可以改动开机自启"
        );
        // overlay / consent 这类窗口都不在放行名单里
        assert!(require("overlay-com-pet-hr-ble", "settings", "设置窗", "撤销授权").is_err());
    }

    /// B2：带 pluginId 的插件调用面 —— 未授权被拒、授权后放行、逐项校验、非法 id 被拒
    #[test]
    fn plugin_capability_requires_grant_and_valid_id() {
        let state = PermissionState::new();
        assert!(plugin_capability(&state, "zz.probe", "agent:hooks").is_err());
        state.grant("zz.probe", &["agent:hooks".to_string()]);
        assert!(plugin_capability(&state, "zz.probe", "agent:hooks").is_ok());
        // 逐项校验：同一插件没授权的另一个能力仍然被拒
        assert!(plugin_capability(&state, "zz.probe", "ble:scan").is_err());
        // 别的插件没被连带授权
        assert!(plugin_capability(&state, "zz.other", "agent:hooks").is_err());
        // 非法 id 一律拒（与 is_safe_id 对齐）
        assert!(plugin_capability(&state, "../evil", "agent:hooks").is_err());
    }
}
