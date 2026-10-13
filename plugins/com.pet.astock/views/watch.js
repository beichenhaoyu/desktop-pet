// 视图订阅：收 *:widget 回灌；beatMs > 0 时按期续一次 sync（设置页盘面用）。

import { TOPIC_CMD, TOPIC_WIDGET } from "../topics.js";

/**
 * 订阅视图数据；返回退订函数交给 cleanups。
 * beatMs > 0 时定时重发一次 sync —— 设置页用它给盘面面板续期（人不在页上就没人续，
 * 主逻辑那边 90 秒后自动停止额外出网）。
 */
export function watchView(ctx, render, { beatMs = 0 } = {}) {
  const off = ctx.bus.subscribe(TOPIC_WIDGET, (d) => render(d ?? {}));
  ctx.bus.publish(TOPIC_CMD, { action: "sync" }); // 面板刚建好时主动要一份（宿主回灌是双保险）
  if (!(beatMs > 0)) return off;
  const timer = setInterval(() => ctx.bus.publish(TOPIC_CMD, { action: "sync" }), beatMs);
  return () => {
    clearInterval(timer);
    off();
  };
}
