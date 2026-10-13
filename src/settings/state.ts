import type { PluginManifest } from "../runtime/plugin-runtime";

/** 宠物设置 = 非插件功能的全部配置项；插件页 = 宿主给壳，内容交给插件的 widget */
export const PET_VIEW = "pet";

export let manifests: PluginManifest[] = [];
export let selected = PET_VIEW;
/** 当前挂在插件页里的 widget 属于哪个插件（切插件时要先收掉上一个） */
export let mountedFor: string | null = null;
/** 侧栏点插件 → 切视图：main.ts 是入口装配文件、不对外导出，回调经这个槽注入 */
export let navigate: (view: string) => Promise<void> = () => Promise.resolve();

// 跨模块共享的可变状态只此一份：拆分前它们是 main.ts 的模块级 let，
// 拆开后各模块只许 import 读取；写一律走下面的 setter（ESM 导入绑定不可赋值）。

export function setManifests(list: PluginManifest[]): void {
  manifests = list;
}

export function setSelected(view: string): void {
  selected = view;
}

export function setMountedFor(id: string | null): void {
  mountedFor = id;
}

export function setNavigate(fn: (view: string) => Promise<void>): void {
  navigate = fn;
}
