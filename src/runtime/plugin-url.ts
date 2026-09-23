// 插件代码经宿主自定义协议 petplugin://<id>/<相对路径> 加载（Windows 上即 http://petplugin.localhost/…）。
// 磁盘上插件放在哪里只有 Rust 的 plugins_dir() 一个解析点，dev 与打包版因此走同一条路：
// 放进目录即可生效，不再有构建时内嵌的第二份副本。
const PLUGIN_BASE = "http://petplugin.localhost/";

export function pluginFileUrl(pluginId: string, relPath: string | undefined): string {
  if (!relPath) throw new Error(`插件 ${pluginId} 缺少入口文件路径`);
  return `${PLUGIN_BASE}${encodeURIComponent(pluginId)}/${relPath}`;
}
