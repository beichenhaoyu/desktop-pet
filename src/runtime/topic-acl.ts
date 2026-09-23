// topic 命名空间归属：`${pluginId}:xxx` 归该插件所有，其余（ble:heart-rate、host:* 等）归宿主。
// 插件只能在自己命名空间内发布；跨命名空间订阅必须 manifest 显式声明 bus:subscribe，
// 且通配订阅不得越过自己的前缀。这里只是防串门的策略层，授权与否仍由 Rust 判定。

function isOwn(pluginId: string, topic: string): boolean {
  return topic.startsWith(`${pluginId}:`);
}

export function assertPublishable(pluginId: string, topic: string): void {
  if (!topic.endsWith("*") && isOwn(pluginId, topic)) return;
  throw new Error(
    `[${pluginId}] 无权发布 topic "${topic}"：只能发布 "${pluginId}:" 前缀（宿主 topic 由宿主注入）`,
  );
}

export function assertSubscribable(pluginId: string, topic: string, permissions: string[]): void {
  if (isOwn(pluginId, topic)) return;
  if (topic.endsWith("*")) {
    throw new Error(`[${pluginId}] 通配订阅 "${topic}" 越过了自己的命名空间`);
  }
  if (!permissions.includes("bus:subscribe")) {
    throw new Error(`[${pluginId}] 订阅 "${topic}" 需要在 manifest 声明 bus:subscribe`);
  }
}

/** 交给插件/widget 的总线视图：只有 publish/subscribe，拿不到 handlers 与 inject */
export type ScopedBus = {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
};

export function createScopedBus(
  pluginId: string,
  permissions: string[],
  bus: ScopedBus,
): ScopedBus {
  return Object.freeze({
    publish: (topic: string, payload: unknown): void => {
      assertPublishable(pluginId, topic);
      if (!permissions.includes("bus:publish")) {
        throw new Error(`[${pluginId}] 发布需要在 manifest 声明 bus:publish`);
      }
      bus.publish(topic, payload);
    },
    subscribe: (topic: string, handler: (payload: unknown) => void): (() => void) => {
      assertSubscribable(pluginId, topic, permissions);
      return bus.subscribe(topic, handler);
    },
  });
}
