// 入口小壳：生命周期转发 + 唯一出网口 out()。
// 所有请求必须经过这里；api.js 只拼 URL，不直接调宿主 HTTP 桥。
import { ctx } from "./main.js";
import {
  cooldownMs,
  createGate,
  FAILS_BEFORE_COOLDOWN,
  isThrottleStatus,
  isTransportError,
} from "./throttle.js";

export { activate, deactivate } from "./main.js";

export const gate = createGate();
export let cooldownUntil = 0;
export let cooldownReason = "";
let cooldownStrikes = 0;
let fails = 0;

function cooldownError() {
  const err = /** @type {Error & {kind?: string, cooldown?: boolean, retryAt?: number}} */ (
    new Error(`限流冷却中，约 ${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒后自动恢复`)
  );
  err.kind = "cooldown";
  err.cooldown = true;
  err.retryAt = cooldownUntil;
  return err;
}

/** 429 / 连续失败进入阶梯冷却；成功后由 resetThrottle() 归零。 */
export function enterCooldown(reason) {
  cooldownStrikes += 1;
  cooldownUntil = Date.now() + cooldownMs(cooldownStrikes);
  cooldownReason = String(reason ?? "");
  fails = 0;
}

export function resetThrottle() {
  cooldownStrikes = 0;
  cooldownUntil = 0;
  cooldownReason = "";
  fails = 0;
}

/** 普通失败（5xx / 解析失败）计数；连续 3 次进冷却。 */
export function noteFailure() {
  fails += 1;
  if (fails >= FAILS_BEFORE_COOLDOWN) enterCooldown(`连续 ${fails} 次请求失败`);
}

function checkCooldown() {
  if (Date.now() < cooldownUntil) throw cooldownError();
}

/**
 * 唯一的出网口子：冷却 → 闸门 → 请求。传输层失败重试一次；
 * 429/403 之外的 HTTP 状态由 api.js 分类。宿主 http 不返回响应头，
 * 所以方案里的 Retry-After 读不到，只能走本地冷却阶梯。
 */
export async function out(url, opts) {
  if (!ctx) throw new Error("插件已停用");

  const once = async () => {
    checkCooldown();
    await gate.acquire();
    if (!ctx) throw new Error("插件已停用");
    const resp = await ctx.http.request(url, opts);
    if (isThrottleStatus(resp.status)) enterCooldown(`HTTP ${resp.status}`);
    return resp;
  };

  try {
    // 2xx 不在这里算成功：api.js 解析成功后才 resetThrottle()，
    // 否则「2xx + 坏 JSON」会让连续解析失败永远攒不到 3 次。
    return await once();
  } catch (err) {
    if (err?.cooldown || err?.kind === "cooldown") throw err;
    if (isThrottleStatus(Number(err?.status ?? 0))) {
      enterCooldown(String(err?.message ?? err));
      throw err;
    }
    if (!isTransportError(err)) throw err;
    try {
      return await once();
    } catch (err2) {
      if (!err2?.cooldown) noteFailure();
      throw err2;
    }
  }
}
