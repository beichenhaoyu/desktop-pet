// 入口小壳。宿主给入口文件的 URL 追加 ?v=<mtime> 做缓存失效，而插件内部其它文件用
// 不带查询串的 URL 互相 import —— 两者对 "./index.js" 会解析成不同的模块实例（node 实测），
// 共享状态跨这个边界会双双失效。所以：生命周期与共享状态都在 main.js，本文件只留两样：
//   1) 契约导出：把 activate / deactivate 原样转发出去；
//   2) 出网口 out()：verify:astock 按「文件名 + 函数名」grep 它的唯一性，位置不能挪。
// 拆分全景见 .dispatch/arch-p2/work/M4/move-map.md。

import { ctx } from "./main.js";
import { cooldownUntil, enterCooldown } from "./core.js";
import { createGate, FAILS_BEFORE_COOLDOWN, isThrottleError, isTransportError } from "./throttle.js";

export { activate, deactivate } from "./main.js";

/* 出网节制：所有请求都必须过 out()，别绕过去直接调 ctx.http.request */
export const gate = createGate();
let fails = 0; // 连续普通失败次数

/**
 * 唯一的出网口子：冷却 → 闸门（最小间隔 + 每分钟上限）→ 请求 → 记账。
 * 传输层失败（连接被掐）在这里重试一次，所以面板/主轮询/搜索三条路径都能享受到，
 * 不用各自再写一遍；429/403 与「连续多次失败」则进冷却阶梯 —— 被拒之后继续按原节奏撞，
 * 等于把一次临时限流坐实成长期封禁。
 */
export async function out(url, opts) {
  if (!ctx) throw new Error("插件已停用");
  const check = () => {
    const now = Date.now();
    if (now < cooldownUntil) {
      const err = new Error(`限流冷却中，约 ${Math.ceil((cooldownUntil - now) / 1000)} 秒后自动恢复`);
      err.cooldown = true;
      throw err;
    }
  };
  const once = async () => {
    check();
    await gate.acquire();
    const resp = await ctx.http.request(url, opts);
    if (isThrottleError(resp)) enterCooldown(`HTTP ${resp.status}`);
    return resp;
  };
  try {
    const resp = await once();
    fails = 0;
    return resp;
  } catch (err) {
    if (err?.cooldown) throw err;
    if (isThrottleError(err)) {
      enterCooldown(String(err?.message ?? err));
      throw err;
    }
    if (!isTransportError(err)) {
      countFailure(err);
      throw err;
    }
    try {
      const resp = await once();
      fails = 0;
      return resp;
    } catch (err2) {
      if (!err2?.cooldown) countFailure(err2);
      throw err2;
    }
  }
}

function countFailure(err) {
  if (isThrottleError(err)) return enterCooldown(String(err?.message ?? err));
  fails += 1;
  if (fails >= FAILS_BEFORE_COOLDOWN) enterCooldown(`连续 ${fails} 次请求失败`);
  return undefined;
}
