//! 窗口来源门禁：命令由哪个窗口发来，决定它能不能改宿主。
//!
//! 判定只看 `window.label()` —— 那是宿主自己建窗时定的，前端伪造不了。
//! 插件 JS 就跑在宠物窗里，所以这条门禁拦得住「绕过 JS 桥直接 invoke」的插件越权；
//! 拦不住的是宠物窗内插件之间的区分（同 realm，宿主看不出是哪个插件），
//! 那要等 Web Worker 宿主才收口（见 ARCHITECTURE.md 信任模型）。
use tauri::Window;

/// 跨会话生效的系统级开关、授权表、形象与 hook 配置：只认设置窗
pub fn settings(window: &Window, what: &str) -> Result<(), String> {
    require(window.label(), "settings", "设置窗", what)
}

/// 影响宠物本体显隐与宿主窗口自身的动作：只认宠物窗
pub fn pet(window: &Window, what: &str) -> Result<(), String> {
    require(window.label(), "pet", "宠物窗", what)
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
    use super::require;

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
}
