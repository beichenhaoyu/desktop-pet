// 出网节制：把「个人盯盘插件」的请求压成一条温和、会自己刹车的线。
//
// 背景：东财这套是公开行情接口，没有配额也没有文档，服务端按行为模式识别反爬。
// 我们的量其实很低（20 只自选股只发 1 条批量请求，最坏约 0.4 次/秒、24 次/分钟），
// 真正像爬虫的是另外三件事 —— 节拍完美等间隔、休市也 7×24 不停、以及**被拒之后还照原样打**。
// 最后一条最要命：一旦被限流还按 20 秒一次继续撞，等于把临时限流坐实成长期封禁。
// 所以这里重点不是压总量，而是「撞到墙就退开」。
//
// 全是纯函数 + 一个可注入时钟的闸门，不碰网络也不碰 ctx，回归脚本可以直接 import 断言。

/** 两次出网之间的最小间隔：任何情况下都不会出现「每秒 5 次」那种尖峰 */
export const MIN_GAP_MS = 350;
/** 滚动 60 秒窗口的调用上限。面板一轮最多 3 次、主轮询 1 次，正常用不到这条，它挡的是异常重入 */
export const MAX_CALLS_PER_MIN = 30;
/** 被限流后的冷却阶梯：1 分钟 → 5 分钟 → 15 分钟 → 30 分钟封顶 */
export const COOLDOWN_STEPS_MS = [60_000, 300_000, 900_000, 1_800_000];
/** 连续失败这么多次就进入冷却（不只是 429：连接被掐断同样说明对端不想理我们） */
export const FAILS_BEFORE_COOLDOWN = 3;
/** 休市/节假日退避的上限：没必要一直打，但也不能永远停（用户可能忘了自己在盯盘） */
export const IDLE_MAX_SEC = 1800;
/** 节拍抖动比例：±15%，避免间隔精确到毫秒成为特征 */
export const JITTER_RATIO = 0.15;

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

/**
 * 出网闸门：串行化 + 滚动窗口限流。
 * `now` 可注入，方便单测里造时间。
 */
export function createGate({
  now = () => Date.now(),
  minGapMs = MIN_GAP_MS,
  perMinute = MAX_CALLS_PER_MIN,
} = {}) {
  let lastAt = -Infinity;
  const hits = [];

  function prune(t) {
    while (hits.length && t - hits[0] >= 60_000) hits.shift();
  }

  return {
    /** 现在发还要等多久（毫秒），0 表示可以立刻发 */
    waitMs() {
      const t = now();
      prune(t);
      const gap = lastAt + minGapMs - t;
      const cap = hits.length >= perMinute ? 60_000 - (t - hits[0]) : 0;
      return Math.max(0, gap, cap);
    },
    /** 记一次出网。调用方应当先 await acquire() */
    take() {
      const t = now();
      lastAt = t;
      hits.push(t);
      return t;
    },
    async acquire() {
      const w = this.waitMs();
      if (w > 0) await sleep(w);
      return this.take();
    },
    stats() {
      prune(now());
      return { window: hits.length, perMinute, minGapMs };
    },
  };
}

/**
 * 传输层失败（连接被掐、超时）与「对端在拒绝我们」要分开看：
 * 前者重试一次通常就好了（实测东财偶发 `fetch failed` / rustls unexpected-eof，
 * 紧接着同一 URL 又能正常返回），后者必须退开。
 * 带明确 4xx/5xx 状态的走 isThrottleError，不在这里重试。
 */
export function isTransportError(err) {
  if (Number(err?.status ?? 0) >= 400) return false;
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return /network|fetch failed|eof|reset|timed out|timeout|connection|aborted|断开|超时/.test(text);
}

/**
 * 判断一次失败是不是「对端在限流/拒绝我们」。
 * 429/403 是明确信号；连接被掐断（rustls unexpected-eof 那类）按普通失败计数，
 * 攒够 FAILS_BEFORE_COOLDOWN 次同样进冷却 —— 分不清的时候就该往保守的那边走。
 */
export function isThrottleError(err) {
  const status = Number(err?.status ?? err?.code ?? 0);
  if (status === 429 || status === 403) return true;
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return /too many|rate.?limit|blocked|429|forbidden|频繁|封/.test(text);
}

/** 第 strikes 次触发限流要冷却多久（阶梯，封顶 COOLDOWN_STEPS_MS 最后一档） */
export function cooldownMs(strikes) {
  const i = Math.max(1, Math.round(strikes) || 1) - 1;
  return COOLDOWN_STEPS_MS[Math.min(i, COOLDOWN_STEPS_MS.length - 1)];
}

/**
 * 下一轮的间隔：盘中用用户设的值；行情时间戳不前进（休市/停牌/节假日）就按 2 的幂退避到上限。
 * `noProgress` 是「连续多少轮时间戳没动」，一旦有进展就归零，所以恢复是即时的。
 */
export function nextIntervalSec({ tradingSec, idleSec, noProgress, capSec = IDLE_MAX_SEC }) {
  const base = Math.max(1, tradingSec);
  if (!noProgress || noProgress < 1) return base;
  const grown = Math.max(1, idleSec) * 2 ** Math.min(noProgress - 1, 8);
  return Math.min(capSec, Math.max(base, Math.round(grown)));
}

/** 给节拍加 ±ratio 的抖动；rnd 传 0.5 时等于不抖（单测用） */
export function jittered(sec, rnd = Math.random, ratio = JITTER_RATIO) {
  const base = Math.max(1, sec);
  const factor = 1 + (rnd() * 2 - 1) * ratio;
  return Math.max(1, Math.round(base * factor));
}
