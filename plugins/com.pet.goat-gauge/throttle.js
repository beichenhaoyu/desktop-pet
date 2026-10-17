// 出网节制：串行 + 最小间隔 + 每分钟上限 + 429/连续失败的冷却阶梯。
// 全是可注入时钟的纯逻辑；网络调用在 index.js 的 out()。
export const MIN_GAP_MS = 400;
export const MAX_CALLS_PER_MIN = 20;
export const COOLDOWN_STEPS_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000];
export const FAILS_BEFORE_COOLDOWN = 3;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @param {{ now?: () => number, minGapMs?: number, perMinute?: number }} options
 */
export function createGate({
  now = () => Date.now(),
  minGapMs = MIN_GAP_MS,
  perMinute = MAX_CALLS_PER_MIN,
} = {}) {
  let lastAt = -Infinity;
  const hits = [];
  let chain = Promise.resolve();

  function prune(t) {
    while (hits.length && t - hits[0] >= 60_000) hits.shift();
  }

  function waitMs() {
    const t = now();
    prune(t);
    const gap = lastAt + minGapMs - t;
    const cap = hits.length >= perMinute ? 60_000 - (t - hits[0]) : 0;
    return Math.max(0, gap, cap);
  }

  function take() {
    const t = now();
    lastAt = t;
    hits.push(t);
    return t;
  }

  return {
    waitMs,
    take,
    /** 串行化：同一时间只放一个请求过闸，后到的等前一个 take() 之后再算间隔。 */
    async acquire() {
      const run = async () => {
        const wait = waitMs();
        if (wait > 0) await sleep(wait);
        take();
      };
      const current = chain.then(run, run);
      chain = current.catch(() => undefined);
      await current;
    },
    stats() {
      prune(now());
      return { window: hits.length, perMinute, minGapMs };
    },
  };
}

/** 传输层失败（连接被掐/超时）才重试一次；带 HTTP 状态的不走这里。 */
export function isTransportError(err) {
  if (Number(err?.status ?? 0) >= 400) return false;
  if (err?.kind === "network" || err?.kind === "timeout") return true;
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return /network|fetch failed|eof|reset|timed out|timeout|connection|aborted|断开|超时/.test(text);
}

export function isAuthStatus(status) {
  return status === 401 || status === 403;
}

export function isThrottleStatus(status) {
  return status === 429;
}

/** @param {number} strikes 第几次触发（从 1 开始） */
export function cooldownMs(strikes) {
  const index = Math.max(1, Math.round(strikes) || 1) - 1;
  return COOLDOWN_STEPS_MS[Math.min(index, COOLDOWN_STEPS_MS.length - 1)];
}
