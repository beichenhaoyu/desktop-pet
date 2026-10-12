// Petdex 桌宠形象：名字解析、图集下载、磁盘布局与 petskin:// 协议。
//
// 口径与插件文件同源：仓库不内置任何美术，形象一律由宿主在运行时从 Petdex 公开画廊下载，
// 本项目仅供学习与自娱自乐、不用于商用，也不二次分发这些文件。
// 磁盘位置只有 skins_root() 一个解析点，dev 与打包版走同一条路。
//
// 解析接口是公开的 `https://petdex.dev/api/manifest/v2`（无需鉴权）。它的 `pets` 是**数组的数组**，
// 列顺序由同一响应里的 `fields` 给出 —— 所以下面按字段名取列，不硬编码下标。

pub mod catalog;
pub mod commands;
pub mod download;
pub mod local;
pub mod protocol;

// 这些路径原本是 `crate::services::skins::<名>`，为保持外部调用路径不变而再导出。
// services 是私有模块树，部分名字只被 cfg(test) 的 tests.rs 或跨模块 use 引用，
// 因此在单 lib 构建里会报 unused_imports —— 删掉会破坏路径兼容，故显式放宽该 lint。
#[allow(unused_imports)]
pub use self::catalog::{
    asset_url, is_safe_slug, normalize_name, pick_pet, PetEntry, DEFAULT_SLUG, MANIFEST_URL,
};
#[doc(hidden)]
pub use self::commands::{
    __cmd__pet_skin_active, __cmd__pet_skin_install, __cmd__pet_skin_list, __cmd__pet_skin_remove,
    __cmd__pet_skin_use, __tauri_command_name_pet_skin_active,
    __tauri_command_name_pet_skin_install, __tauri_command_name_pet_skin_list,
    __tauri_command_name_pet_skin_remove, __tauri_command_name_pet_skin_use,
};
pub use self::commands::{
    ensure_default, pet_skin_active, pet_skin_install, pet_skin_list, pet_skin_remove, pet_skin_use,
};
#[allow(unused_imports)]
pub use self::local::{active_pointer, read_meta, skin_dir, skin_url, skins_root, SkinInfo};
pub use self::protocol::register_skin_protocol;

/* ================= 单测 ================= */

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
