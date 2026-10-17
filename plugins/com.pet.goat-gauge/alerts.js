// 告警判定：纯函数。阈值穿越 / 同一窗口去重 / reset_at 变化后重新开放 /
// 首次激活只记 fired、不补发历史告警。
import { fmtCountdown } from "./format.js";

const WINDOWS = {
  five_hour: {
    label: "5 小时",
    thresholdsKey: "fiveHourPct",
    exceeded: "5 小时额度已用尽，请等待窗口重置。",
  },
  weekly: {
    label: "本周",
    thresholdsKey: "weeklyPct",
    exceeded: "本周额度已用尽，请等待周额度重置。",
  },
  monthly: {
    label: "本月",
    thresholdsKey: "monthlyPct",
    exceeded: "本月额度已用尽。",
  },
};

/** @param {unknown} value @returns {number[]} */
function thresholdsOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => b - a)
    .slice(0, 4);
}

/** @param {Record<string, any>} fired @param {number} now @returns {Record<string, number>} */
function prune(fired, now) {
  const entries = Object.entries(fired)
    .filter(([key, at]) => typeof key === "string" && typeof at === "number" && Number.isFinite(at))
    .filter(([key]) => {
      const suffix = key.split(":").at(-1);
      const resetAt = Number(suffix);
      return !Number.isFinite(resetAt) || resetAt === 0 || resetAt > now - 24 * 60 * 60 * 1000;
    })
    .sort(([, a], [, b]) => b - a)
    .slice(0, 200);
  return Object.fromEntries(entries);
}

/** @param {any} window @param {number} now @returns {string} */
function resetSuffix(window, now) {
  const resetAt = Number(window?.reset_at) || 0;
  if (resetAt > 0) return String(resetAt);
  return String(Math.floor(now / 86_400_000));
}

/**
 * @param {Record<string, any> | null} prev
 * @param {Record<string, any>} next
 * @param {{ thresholds?: Record<string, number[]> }} cfg
 * @param {Record<string, number>} fired
 * @param {{ suppress?: boolean, now?: number }} options
 * @returns {{ toFire: Array<Record<string, any>>, firedNext: Record<string, number> }}
 */
export function evaluate(prev, next, cfg, fired, { suppress = false, now = Date.now() } = {}) {
  const firedNext = prune(fired ?? {}, now);
  const events = [];
  const thresholds = cfg?.thresholds ?? {};

  for (const [kind, meta] of Object.entries(WINDOWS)) {
    const window = next?.windows?.[kind];
    if (!window || window.available === false) continue;
    const prevWindow = prev?.windows?.[kind] ?? null;
    const resetAt = Number(window.reset_at) || 0;

    if (window.exceeded && prevWindow?.exceeded !== true) {
      events.push({
        key: `${kind}:exceeded:${resetSuffix(window, now)}`,
        kind: "exceeded",
        level: "danger",
        message: meta.exceeded,
        pet: "failed",
        say: true,
        notify: true,
      });
      continue;
    }

    if (window.exceeded) continue;
    const pct = window.remaining_pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    const prevPct = prevWindow?.remaining_pct;
    // reset_at 变了就是新窗口：即使上一窗也在阈值内，也要重新开放。
    const sameWindow = prevWindow && Number(prevWindow.reset_at) === Number(window.reset_at);
    for (const threshold of thresholdsOf(thresholds[meta.thresholdsKey])) {
      if (pct > threshold) continue;
      if (sameWindow && typeof prevPct === "number" && prevPct <= threshold) continue;
      const countdown = resetAt > now ? `，约 ${fmtCountdown(resetAt, now)} 后重置` : "";
      events.push({
        key: `${kind}:${threshold}:${resetSuffix(window, now)}`,
        kind: "threshold",
        level: "warning",
        message: `${meta.label}额度只剩 ${Math.round(pct)}%${countdown}`,
        pet: "waiting",
        say: true,
        notify: true,
      });
    }
  }

  if (next?.credits?.below_threshold === true && prev?.credits?.below_threshold !== true) {
    const periodEnd = Number(next?.plan?.current_period_end) || 0;
    events.push({
      key: `credit:low:${periodEnd || Math.floor(now / 86_400_000)}`,
      kind: "credit_low",
      level: "warning",
      message: "账户余额已低于预警阈值。",
      pet: "review",
      say: true,
      notify: true,
    });
  }

  if (prev) {
    for (const [kind, meta] of Object.entries(WINDOWS)) {
      const prevWindow = prev?.windows?.[kind];
      const window = next?.windows?.[kind];
      if (!prevWindow || !window) continue;
      const prevReset = Number(prevWindow.reset_at) || 0;
      const nextReset = Number(window.reset_at) || 0;
      if (prevReset > 0 && nextReset > prevReset) {
        events.push({
          key: `${kind}:reset:${nextReset}`,
          kind: "reset",
          level: "info",
          message: `${meta.label}窗口已重置。`,
          pet: "jumping",
          say: false,
          notify: false,
        });
      }
    }
  }

  const toFire = [];
  for (const event of events) {
    if (firedNext[event.key]) continue;
    firedNext[event.key] = now;
    if (!suppress) toFire.push(event);
  }
  return { toFire, firedNext };
}

/** 凭据失效：由 main 在 auth_error 迁移时调用，去重键按保存时间。 */
export function authEvent(savedAt, now = Date.now()) {
  return {
    key: `auth:${Number(savedAt) || 0}`,
    kind: "auth",
    level: "danger",
    message: "Command Code 凭据已失效，用量暂停更新。",
    pet: "failed",
    say: true,
    notify: true,
    now,
  };
}
