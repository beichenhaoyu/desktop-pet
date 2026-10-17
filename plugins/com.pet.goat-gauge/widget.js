// widget 三个区共用入口。清理表按挂载实例存（WeakMap），
// 同一份文件会同时在 badge / overlay / settings 挂载，不能用模块级数组。
import { mountBadge } from "./views/badge.js";
import { mountOverlay } from "./views/overlay.js";
import { mountSettings } from "./views/settings.js";

const scopes = new WeakMap();

export function mount(root, ctx) {
  const cleanups = [];
  scopes.set(root, cleanups);
  if (ctx.region === "badge") mountBadge(root, ctx, cleanups);
  else if (ctx.region === "overlay") mountOverlay(root, ctx, cleanups);
  else if (ctx.region === "settings") mountSettings(root, ctx, cleanups);
}

export function unmount(root) {
  for (const off of scopes.get(root) ?? []) {
    try {
      off();
    } catch {
      /* 单个清理失败不影响其余 */
    }
  }
  scopes.delete(root);
}

// Worker 路线的停用钩子名是 deactivate(root)，宿主 realm 调 unmount(root)
export const deactivate = unmount;
