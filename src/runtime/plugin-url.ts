// 插件代码经宿主自定义协议 petplugin://<id>/<相对路径> 加载（Windows 上即 http://petplugin.localhost/…）。
// 磁盘上插件放在哪里只有 Rust 的 plugins_dir() 一个解析点，dev 与打包版因此走同一条路：
// 放进目录即可生效，不再有构建时内嵌的第二份副本。
import { invoke } from "@tauri-apps/api/core";

const PLUGIN_BASE = "http://petplugin.localhost/";

export function pluginFileUrl(
  pluginId: string,
  relPath: string | undefined,
  bust?: string | number,
): string {
  if (!relPath) throw new Error(`插件 ${pluginId} 缺少入口文件路径`);
  const url = `${PLUGIN_BASE}${encodeURIComponent(pluginId)}/${relPath}`;
  // webview 的模块缓存按 URL 记：URL 恒定不变的话，覆盖 entry.js 永远命中旧模块，
  // 「目录变动即时生效」对代码变更就不成立了。查询串只影响 URL，协议侧按 path 找文件。
  return bust === undefined || bust === "" ? url : `${url}?v=${encodeURIComponent(String(bust))}`;
}

/**
 * 取插件文件的修改时间当 cache-busting 令牌。
 * 拿不到（文件正被替换、旧宿主没有这条命令）就返回空串 —— 宁可退回「要重载才生效」，
 * 也不该因为一次 stat 失败而拒绝加载插件。
 */
export async function pluginFileVersion(pluginId: string, relPath: string): Promise<string> {
  try {
    return String(await invoke<number>("plugin_file_version", { pluginId, rel: relPath }));
  } catch {
    return "";
  }
}
