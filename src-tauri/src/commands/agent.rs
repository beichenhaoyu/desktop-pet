//! Agent hook 的宿主命令：状态 / 安装 / 卸载。
//!
//! 这三个命令会改写用户自己的 Agent 配置（`~/.qoder*/settings.json`），
//! 权限比任何插件能力都高，所以只接受设置窗的调用 —— 插件即便绕过 JS 桥
//! 直接 invoke，也拿不到这个入口。

use std::path::PathBuf;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::services::agent::HOOK_PHASES;
use crate::services::agent_hooks;

fn assert_settings_caller(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("只有设置窗可以查询或改动 Agent hook".into())
    }
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
pub fn agent_hooks_status(window: tauri::Window, app: AppHandle) -> Result<Value, String> {
    assert_settings_caller(&window)?;
    snapshot(&app)
}

#[tauri::command]
pub fn agent_hooks_install(window: tauri::Window, app: AppHandle) -> Result<Value, String> {
    assert_settings_caller(&window)?;
    let files = agent_hooks::candidate_files(&home_dir(&app)?);
    if files.is_empty() {
        return Err("没找到 Qoder 的配置目录（~/.qoder 或 ~/.qoder-cn）".into());
    }
    let reports = agent_hooks::install_files(&files, &exe_path()?);
    Ok(json!({ "files": reports }))
}

#[tauri::command]
pub fn agent_hooks_uninstall(window: tauri::Window, app: AppHandle) -> Result<Value, String> {
    assert_settings_caller(&window)?;
    let files = agent_hooks::candidate_files(&home_dir(&app)?);
    let reports = agent_hooks::uninstall_files(&files);
    Ok(json!({ "files": reports }))
}
