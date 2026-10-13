// 盯盘插件的界面：badge（宠物旁小字）、overlay（左上角盯盘卡）、settings（插件页）。
// 三个区域共用一份由 index.js 推来的视图数据（`com.pet.astock:widget`），
// 界面自己不发请求、也不算规则 —— 这样重新挂载时只要宿主回灌那一份就够了。
//
// 遵守 SDK 三条硬规矩：只往 shadow root 里写；清理表按挂载实例存（WeakMap）；
// 外部数据一律 textContent，绝不拼进 innerHTML（股票名、搜索结果、行情值都算外部数据）。
// 2026-10-13 按视图拆分（M4）：三个区域在 views/{badge,overlay,settings}.js，共用小件在 views/{dom,watch}.js。
import { PID } from "./topics.js";
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
      /* 忽略 */
    }
  }
  scopes.delete(root);
}

export { PID };
