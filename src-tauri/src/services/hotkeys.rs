// 全局快捷键：按一个键唤出「插件页」（设置窗）。
//
// 加速键字符串由用户输入，所以先过一遍白名单校验再交给系统注册 ——
// 直接透传给 global-hotkey 的话，非法串会以库内部错误的面目冒出来，很难归因。
// 换键的顺序是「先注册新的，成功才注销旧的」：注册失败（多半是被别的应用占了）
// 时保持原键可用，不会把用户搞得两个键都没了。
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::fsutil::write_atomic;

pub const DEFAULT_ACCEL: &str = "CommandOrControl+Alt+P";

const MODIFIERS: &[(&str, &str)] = &[
    ("ctrl", "Ctrl"),
    ("control", "Ctrl"),
    // Tauri 的跨平台写法：Windows 上是 Ctrl、mac 上是 Cmd。
    // 它同时是默认值里的 token，不认的话「恢复默认」这条按钮就永远走不通
    ("cmdorctrl", "CommandOrControl"),
    ("commandorcontrol", "CommandOrControl"),
    ("cmdorwin", "CommandOrControl"),
    ("commandorwindow", "CommandOrControl"),
    ("cmd", "Super"),
    ("command", "Super"),
    ("super", "Super"),
    ("win", "Super"),
    ("windows", "Super"),
    ("meta", "Super"),
    ("alt", "Alt"),
    ("option", "Alt"),
    ("shift", "Shift"),
];

/// 允许出现在修饰键位置之外的键名。太宽会让用户注册出系统级冲突键
const KEYS: &[&str] = &[
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
    "Space",
    "Tab",
    "Esc",
    "Enter",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
];

/// 把用户写的各种写法（`Ctrl+Alt+p` / `control+alt+P` / `Ctrl P`）归一成
/// Tauri 认的 `Ctrl+Alt+P`。必须至少一个修饰键 + 恰好一个主键。
pub fn normalize_accel(raw: &str) -> Result<String, String> {
    let tokens: Vec<String> = raw
        .split(['+', '-', ' '])
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Err("加速键为空".into());
    }
    let mut mods: Vec<&'static str> = Vec::new();
    let mut key: Option<&'static str> = None;
    for token in tokens {
        let lower = token.to_lowercase();
        if let Some((_, canon)) = MODIFIERS.iter().find(|(alias, _)| *alias == lower) {
            if !mods.contains(canon) {
                mods.push(canon);
            }
            continue;
        }
        if let Some(canon) = KEYS.iter().find(|k| k.to_lowercase() == lower) {
            if key.is_some() {
                return Err(format!("只能有一个主键，多出来的是「{token}」"));
            }
            key = Some(canon);
            continue;
        }
        return Err(format!("不支持的按键「{token}」"));
    }
    if mods.is_empty() {
        return Err("至少要带一个修饰键（Ctrl / Alt / Shift / Win），避免劫持普通输入".into());
    }
    let Some(main) = key else {
        return Err("缺少主键，例如 Ctrl+Alt+P".into());
    };
    // Ctrl 与 CmdOrCtrl 等价，但 CmdOrCtrl 在 mac/win 上语义更清楚，这里统一按用户写的来
    Ok(format!("{}+{main}", mods.join("+")))
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|e| e.to_string())
}

fn read_saved(app: &AppHandle) -> Option<String> {
    let path = settings_file(app).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("hotkey")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn write_saved(app: &AppHandle, accel: &str) -> Result<(), String> {
    let path = settings_file(app)?;
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    doc["hotkey"] = Value::String(accel.to_string());
    // A2 混迁桥：write_saved 还是裸 String 签名（A05 迁移时删掉这行 map_err）
    write_atomic(
        &path,
        serde_json::to_vec_pretty(&doc)
            .map_err(|e| e.to_string())?
            .as_slice(),
    )
    .map_err(String::from)
}

/// 注册并落盘。启动时由 setup 调用一次。
pub fn apply(app: &AppHandle, accel: &str) -> Result<(), String> {
    app.global_shortcut()
        .register(accel)
        .map_err(|e| format!("注册 {accel} 失败：{e}"))
}

fn unregister(app: &AppHandle, accel: &str) {
    let _ = app.global_shortcut().unregister(accel);
}

#[tauri::command]
pub fn hotkey_status(app: AppHandle) -> Result<Value, String> {
    Ok(json!({
        "accelerator": read_saved(&app).unwrap_or_else(|| DEFAULT_ACCEL.to_string()),
        "default": DEFAULT_ACCEL,
    }))
}

/// 换键：只认设置窗。先注册新键，成功才注销旧键并落盘。
#[tauri::command]
pub fn hotkey_set(
    app: AppHandle,
    window: tauri::Window,
    accelerator: String,
) -> Result<String, String> {
    crate::gate::settings(&window, "改动快捷键")?;
    let next = normalize_accel(&accelerator)?;
    let current = read_saved(&app).unwrap_or_else(|| DEFAULT_ACCEL.to_string());
    if current == next {
        return Ok(next);
    }
    apply(&app, &next)?;
    unregister(&app, &current);
    write_saved(&app, &next)?;
    Ok(next)
}

/// 只测一下能不能注册（不改变现状）：给界面上的「测试」按钮用。
/// 注册这一步会短暂占用系统级快捷键，所以同样只认设置窗。
#[tauri::command]
pub fn hotkey_test(
    app: AppHandle,
    window: tauri::Window,
    accelerator: String,
) -> Result<bool, String> {
    crate::gate::settings(&window, "试注册快捷键")?;
    let probe = normalize_accel(&accelerator)?;
    // 试的就是当前生效的那个键：注册必然报「已占用」，那不是冲突。
    // 比较对象必须是「当前生效」的键，而不是「已落盘」的 —— 没落盘时生效的是默认值
    let current = read_saved(&app).unwrap_or_else(|| DEFAULT_ACCEL.to_string());
    if current == probe {
        return Ok(true);
    }
    match apply(&app, &probe) {
        Ok(()) => {
            unregister(&app, &probe);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// 启动时恢复用户上次选的键；没注册成功就退回默认值，别让设置窗再也叫不出来
pub fn restore(app: &AppHandle) {
    let saved = read_saved(app).unwrap_or_else(|| DEFAULT_ACCEL.to_string());
    if apply(app, &saved).is_err() && saved != DEFAULT_ACCEL {
        if let Err(err) = apply(app, DEFAULT_ACCEL) {
            log::warn!("[hotkey] 默认加速键也注册失败: {err}");
            return;
        }
        let _ = write_saved(app, DEFAULT_ACCEL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_spellings() {
        assert_eq!(normalize_accel("Ctrl+Alt+p").unwrap(), "Ctrl+Alt+P");
        assert_eq!(normalize_accel("control + alt + P").unwrap(), "Ctrl+Alt+P");
        assert_eq!(normalize_accel("cmd-shift-d").unwrap(), "Super+Shift+D");
        assert_eq!(normalize_accel("Alt+F12").unwrap(), "Alt+F12");
    }

    #[test]
    fn accepts_tauri_cross_platform_tokens() {
        // 默认值本身必须能被校验器接受，否则「恢复默认」永远失败
        assert_eq!(
            normalize_accel(DEFAULT_ACCEL).unwrap(),
            "CommandOrControl+Alt+P"
        );
        assert_eq!(
            normalize_accel("CmdOrCtrl+Shift+Space").unwrap(),
            "CommandOrControl+Shift+Space"
        );
    }

    #[test]
    fn dedupes_repeated_modifiers() {
        assert_eq!(normalize_accel("ctrl+control+P").unwrap(), "Ctrl+P");
    }

    #[test]
    fn requires_a_modifier() {
        assert!(normalize_accel("P").unwrap_err().contains("修饰键"));
    }

    #[test]
    fn requires_exactly_one_main_key() {
        assert!(normalize_accel("Ctrl+Alt").unwrap_err().contains("主键"));
        assert!(normalize_accel("Ctrl+A+B").unwrap_err().contains("主键"));
    }

    #[test]
    fn rejects_unknown_tokens() {
        assert!(normalize_accel("Ctrl+MouseLeft").is_err());
        assert!(normalize_accel("Hyper+P").is_err());
        assert!(normalize_accel("").is_err());
        assert!(normalize_accel("   ").is_err());
    }

    #[test]
    fn rejects_plain_letter_keys_without_modifiers_to_avoid_hijacking() {
        // 单键热键会吞掉正常输入，必须挡住
        assert!(normalize_accel("A").is_err());
    }
}
