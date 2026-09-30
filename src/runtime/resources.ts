// 宿主级共享资源的持有者登记。
// 多个插件跑在同一个窗口、共用同一份 Rust 侧状态（同一条 BLE 连接、同一次扫描），
// 因此任何一方停用时都不能无脑关资源 —— 只有最后一个持有者退出才真正释放。
// overlay 不在这里：悬浮窗按插件各开一扇（overlay-<id>），本来就互不共享。
export type SharedResource = "ble" | "ble-scan";

const holders = new Map<SharedResource, Set<string>>([
  ["ble", new Set()],
  ["ble-scan", new Set()],
]);

export function claim(kind: SharedResource, pluginId: string): void {
  holders.get(kind)?.add(pluginId);
}

/**
 * 释放某个插件的占用。
 * 返回 true 仅当：调用者确实是持有者，且它走之后已无人持有。
 * 非持有者调用返回 false —— 否则一个没用过 BLE 的插件停用时反而会把别人的会话掐断。
 */
export function release(kind: SharedResource, pluginId: string): boolean {
  const set = holders.get(kind);
  if (!set || !set.delete(pluginId)) return false;
  return set.size === 0;
}

/** 插件停用时一次性释放它占过的所有共享资源 */
export function releaseAll(pluginId: string): Record<SharedResource, boolean> {
  return {
    ble: release("ble", pluginId),
    "ble-scan": release("ble-scan", pluginId),
  };
}
