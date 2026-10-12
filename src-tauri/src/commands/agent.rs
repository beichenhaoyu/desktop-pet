//! Agent hook 的宿主命令：状态 / 安装 / 卸载。
//!
//! 两个调用面（见 ADR-0001）：
//!   * 不带 `pluginId` —— 宿主自己的调用（设置窗壳里「撤销授权」的连带卸载要用），
//!     照旧只过 `gate::settings`。别把宿主路径也绑上 pluginId，否则撤销流程会依赖插件还活着。
//!   * 带 `pluginId` —— 插件设置页经 JS 桥的调用，除窗口门禁外再逐项校验 `agent:hooks` 已授权。
//!
//! 门禁挡的是**别的窗口**（宠物窗 / overlay 窗里绕过 JS 桥直接 invoke 会被拒）；
//! 挡不住的是同 realm 里插件的主动越权 —— settings 区的 widget 本来就跑在设置窗里，
//! `label == "settings"` 对它天然成立，边界靠 manifest 声明 + 同意框，不是靠窗口身份。
//! 那条缺口要等 Web Worker 宿主才收口，别在这条注释里给自己假安全感。

use std::path::PathBuf;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::services::agent::HOOK_PHASES;
use crate::services::agent_hooks;
use crate::services::permission::PermissionState;

/// 插件调用本组命令需要的能力名（只在 settings 区 widget 的 `ctx.host.agentHooks` 上可达）
pub const AGENT_HOOKS_CAP: &str = "agent:hooks";

/// 调用面判定：任何调用都要过设置窗门禁；带 pluginId 的插件路径再加一层能力校验
fn assert_caller(app: &AppHandle, window: &tauri::Window, plugin_id: Option<&str>, what: &str) -> Result<(), String> {
    crate::gate::settings(window, what)?;
    if let Some(pid) = plugin_id {
        let perms = app.state::<PermissionState>();
        crate::gate::plugin_capability(&perms, pid, AGENT_HOOKS_CAP)?;
    }
    Ok(())
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|e| e.to_string())
}

fn exe_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("取不到自身路径: {e}"))
}

fn snapshot(app: &AppHandle) -> Result<Value, String> {
    let files = agent_hooks::candidate_files(&home_dir(app)?);
    let reports = agent_hooks::status_reports(&files);
    let managed: usize = reports.iter().map(|r| r.managed).sum();
    let expected = HOOK_PHASES.len();
    Ok(json!({
        "exe": exe_path().map(|p| p.display().to_string()).unwrap_or_default(),
        "files": reports,
        "managed": managed,
        // 装了但条数不对（比如换过 exe 路径）时，UI 该提示「需要修复」而不是「已安装」
        "installed": managed > 0 && files.len() * expected == managed,
        "expectedPerFile": expected,
    }))
}

#[tauri::command]
pub fn agent_hooks_status(app: AppHandle, window: tauri::Window, plugin_id: Option<String>) -> Result<Value, String> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    snapshot(&app)
}

#[tauri::command]
pub fn agent_hooks_install(app: AppHandle, window: tauri::Window, plugin_id: Option<String>) -> Result<Value, String> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    let files = agent_hooks::candidate_files(&home_dir(&app)?);
    if files.is_empty() {
        return Err("没找到 Qoder 的配置目录（~/.qoder 或 ~/.qoder-cn）".into());
    }
    let reports = agent_hooks::install_files(&files, &exe_path()?);
    Ok(json!({ "files": reports }))
}

#[tauri::command]
pub fn agent_hooks_uninstall(app: AppHandle, window: tauri::Window, plugin_id: Option<String>) -> Result<Value, String> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    let files = agent_hooks::candidate_files(&home_dir(&app)?);
    let reports = agent_hooks::uninstall_files(&files);
    Ok(json!({ "files": reports }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::HOOK_PHASES;

    /// B2 验收 P0：含他人 hook 条目的样例配置走完 install → uninstall 后，
    /// 自家 `--pet-hook` 条目归零、别人的条目一字未动。
    /// 用临时目录里的真实文件走完整写入管线（备份 + 原子替换），全程不碰用户配置。
    #[test]
    fn install_then_uninstall_on_temp_file_keeps_foreign_hooks_untouched() {
        let dir = std::env::temp_dir().join(format!("pet-b2-p0-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let sample = r#"{
  "theme": "dark",
  "hooks": {
    "PreToolUse": [
      { "hooks": [
        { "type": "command", "command": "other-tool --notify", "timeout": 5 },
        { "type": "command", "command": "\"D:\\old\\desktop-pet.exe\" --pet-hook pre", "timeout": 2 }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "keep.sh", "timeout": 3 } ] }
    ]
  }
}"#;
        std::fs::write(&path, sample).unwrap();

        let exe = std::path::Path::new(r"C:\app\desktop-pet.exe");
        let reports = agent_hooks::install_files(std::slice::from_ref(&path), exe);
        assert!(reports[0].error.is_none(), "{:?}", reports[0].error);
        assert_eq!(reports[0].managed, HOOK_PHASES.len());

        let installed = std::fs::read_to_string(&path).unwrap();
        // 自家 12 条；别人的两条原样还在；陈旧的自家条目已被摘掉
        assert_eq!(installed.matches("--pet-hook").count(), HOOK_PHASES.len());
        assert!(installed.contains("other-tool --notify"));
        assert!(installed.contains("keep.sh"));
        assert!(!installed.contains("D:\\\\old\\\\desktop-pet.exe"));

        let reports2 = agent_hooks::uninstall_files(std::slice::from_ref(&path));
        assert_eq!(reports2[0].managed, HOOK_PHASES.len());
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(!after.contains("--pet-hook"));

        // 别人条目逐字节未变：同一段落的规范序列化在安装后 / 卸载后完全相同
        let foreign = |text: &str| -> Vec<String> {
            let val: Value = serde_json::from_str(text).unwrap();
            vec![
                val["hooks"]["PreToolUse"][0]["hooks"][0].to_string(),
                val["hooks"]["Stop"][0]["hooks"][0].to_string(),
            ]
        };
        assert_eq!(foreign(&installed), foreign(&after));
        assert_eq!(foreign(&installed)[0], "{\"command\":\"other-tool --notify\",\"timeout\":5,\"type\":\"command\"}");

        // 其余内容也原样：theme 还在，顶层 hooks 只少了自家条目所在的数组项
        let val: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(val["theme"], "dark");
        assert_eq!(agent_hooks::managed_count(&val), 0);
        assert_eq!(val["hooks"]["PreToolUse"][0]["hooks"].as_array().unwrap().len(), 1);
        assert_eq!(val["hooks"]["Stop"][0]["hooks"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
