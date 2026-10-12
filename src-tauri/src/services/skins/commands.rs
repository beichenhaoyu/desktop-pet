use std::fs;

use tauri::{AppHandle, Emitter};

use super::catalog::DEFAULT_SLUG;
use super::download::install_blocking;
use super::local::{
    active_pointer, installed, read_meta, set_active, skin_dir, skins_root, SkinInfo,
};

/* ================= IPC 命令 ================= */

fn only_settings(window: &tauri::Window) -> Result<(), String> {
    crate::gate::settings(window, "安装或切换形象")
}

/// 当前形象；没装好任何皮肤时返回 null，前端退回程序生成帧
#[tauri::command]
pub fn pet_skin_active(app: AppHandle) -> Result<Option<SkinInfo>, String> {
    let Ok(root) = skins_root(&app) else {
        return Ok(None);
    };
    let Some(slug) = active_pointer(&root) else {
        return Ok(None);
    };
    Ok(read_meta(&skin_dir(&root, &slug)?))
}

#[tauri::command]
pub fn pet_skin_list(app: AppHandle) -> Result<Vec<SkinInfo>, String> {
    Ok(installed(&app))
}

#[tauri::command]
pub async fn pet_skin_install(
    app: AppHandle,
    window: tauri::Window,
    name: String,
) -> Result<SkinInfo, String> {
    only_settings(&window)?;
    let sink = app.clone();
    let info = tauri::async_runtime::spawn_blocking(move || install_blocking(&app, &name))
        .await
        .map_err(|e| format!("安装任务失败: {e}"))??;
    let _ = sink.emit("pet:skin-changed", info.clone());
    Ok(info)
}

/// 在已安装的形象之间切换，不重新下载
#[tauri::command]
pub fn pet_skin_use(
    app: AppHandle,
    window: tauri::Window,
    slug: String,
) -> Result<SkinInfo, String> {
    only_settings(&window)?;
    let root = skins_root(&app)?;
    let info = read_meta(&skin_dir(&root, &slug)?).ok_or_else(|| format!("还没有安装过 {slug}"))?;
    set_active(&root, &info.slug)?;
    let _ = app.emit("pet:skin-changed", info.clone());
    Ok(info)
}

#[tauri::command]
pub fn pet_skin_remove(app: AppHandle, window: tauri::Window, slug: String) -> Result<(), String> {
    only_settings(&window)?;
    let root = skins_root(&app)?;
    let dir = skin_dir(&root, &slug)?;
    if !dir.is_dir() {
        return Ok(()); // 幂等：不在就当删过了
    }
    // 只允许删 skins 根目录的直接子目录，别被构造出来的路径带到别处
    if dir.parent() != Some(root.as_path()) {
        return Err("非法的形象目录".into());
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    if active_pointer(&root).as_deref() == Some(slug.as_str()) {
        // 删的正是当前形象：回落到默认（还在）或列表里的第一个
        let fallback = read_meta(&skin_dir(&root, DEFAULT_SLUG)?)
            .map(|i| i.slug)
            .or_else(|| installed(&app).first().map(|i| i.slug.clone()));
        match fallback {
            Some(next) => set_active(&root, &next)?,
            None => {
                let _ = fs::remove_file(root.join("active.json"));
            }
        }
        let _ = app.emit("pet:skin-changed", ());
    }
    Ok(())
}

/* ================= 启动：默认形象 ================= */

/// 首次启动（本地没有任何皮肤）时自动装默认形象。
/// 后台跑：没网络或画廊抽风时只记一条 warn，绝不能把启动卡住。
pub fn ensure_default(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(root) = skins_root(&app) else { return };
        if active_pointer(&root).is_some() || !installed(&app).is_empty() {
            return; // 已经有形象（哪怕是用户自己换过的）就不动
        }
        match install_blocking(&app, DEFAULT_SLUG) {
            Ok(info) => {
                let _ = app.emit("pet:skin-changed", info);
            }
            Err(err) => log::warn!("[skins] 默认形象 {DEFAULT_SLUG} 自动安装失败: {err}"),
        }
    });
}
