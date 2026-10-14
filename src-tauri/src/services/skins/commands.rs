use tauri::{AppHandle, Emitter};

use crate::host_error::{HostError, INTERNAL, NOT_FOUND};

use super::catalog::DEFAULT_SLUG;
use super::download::install_blocking;
use super::local::{
    active_pointer, clear_active, installed, plan_active_after_removal, read_meta, remove_skin_dir,
    set_active, skin_dir, skins_root, SkinInfo,
};

/* ================= IPC 命令 ================= */

fn only_settings(window: &tauri::Window) -> Result<(), HostError> {
    crate::gate::settings(window, "安装或切换形象")
}

/// 当前形象；没装好任何皮肤时返回 null，前端退回程序生成帧
#[tauri::command]
pub fn pet_skin_active(app: AppHandle) -> Result<Option<SkinInfo>, HostError> {
    let Ok(root) = skins_root(&app) else {
        return Ok(None);
    };
    let Some(slug) = active_pointer(&root) else {
        return Ok(None);
    };
    Ok(read_meta(&skin_dir(&root, &slug)?))
}

#[tauri::command]
pub fn pet_skin_list(app: AppHandle) -> Result<Vec<SkinInfo>, HostError> {
    Ok(installed(&app))
}

#[tauri::command]
pub async fn pet_skin_install(
    app: AppHandle,
    window: tauri::Window,
    name: String,
) -> Result<SkinInfo, HostError> {
    only_settings(&window)?;
    let sink = app.clone();
    let info = tauri::async_runtime::spawn_blocking(move || install_blocking(&app, &name))
        .await
        .map_err(|e| HostError::new(INTERNAL, format!("安装任务失败: {e}")))??;
    let _ = sink.emit("pet:skin-changed", info.clone());
    Ok(info)
}

/// 在已安装的形象之间切换，不重新下载
#[tauri::command]
pub fn pet_skin_use(
    app: AppHandle,
    window: tauri::Window,
    slug: String,
) -> Result<SkinInfo, HostError> {
    only_settings(&window)?;
    let root = skins_root(&app)?;
    let info = read_meta(&skin_dir(&root, &slug)?)
        .ok_or_else(|| HostError::new(NOT_FOUND, format!("还没有安装过 {slug}")))?;
    set_active(&root, &info.slug)?;
    let _ = app.emit("pet:skin-changed", info.clone());
    Ok(info)
}

#[tauri::command]
pub fn pet_skin_remove(
    app: AppHandle,
    window: tauri::Window,
    slug: String,
) -> Result<(), HostError> {
    only_settings(&window)?;
    let root = skins_root(&app)?;
    let active = active_pointer(&root);
    let _ = remove_skin_dir(&root, &slug)?;
    // 删除之后重新取列表：回落对象必须是「还在的那些」里的
    let remaining: Vec<String> = installed(&app).iter().map(|i| i.slug.clone()).collect();
    if let Some(next) =
        plan_active_after_removal(&slug, active.as_deref(), DEFAULT_SLUG, &remaining)
    {
        match next {
            Some(slug) => set_active(&root, &slug)?,
            None => clear_active(&root)?,
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
