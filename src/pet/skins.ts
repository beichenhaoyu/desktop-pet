// 宠物皮肤（Petdex 图集）在 webview 侧的唯一解析点。
// 磁盘位置、目录结构与下载都由 Rust 的 services/skins.rs 负责，这里只取结果：
// 图集经宿主自定义协议 petskin://<slug>/<文件> 下发（Windows 上即 http://petskin.localhost/…），
// 与插件文件的 petplugin:// 同一条路 —— dev 与打包版共用，不存在构建时内嵌的第二份副本。
import { invoke } from "@tauri-apps/api/core";

export interface SkinInfo {
  slug: string;
  displayName: string;
  spriteVersionNumber: number;
  url: string;
}

const SKIN_BASE = "http://petskin.localhost/";

export function skinFileUrl(slug: string, file = "sprite.webp"): string {
  return `${SKIN_BASE}${encodeURIComponent(slug)}/${file}`;
}

/** 当前形象；还没装好任何皮肤时返回 null，渲染层用程序生成兜底帧 */
export async function activeSkin(): Promise<SkinInfo | null> {
  return invoke<SkinInfo | null>("pet_skin_active");
}

export async function installedSkins(): Promise<SkinInfo[]> {
  return invoke<SkinInfo[]>("pet_skin_list");
}
