// Ported from goat-gauge (MIT, Copyright (c) 2026 langjinusi985360)
// https://github.com/langjinusi985360/goat-gauge — app/commandcode_api.py
//
// Field fallbacks mirror the Python source: upstream is an undocumented API and
// names have drifted before, so every numeric/string read keeps its old name.
import { planInfo } from "./plans.js";

/* ============ 基础读数：保持 Python 的兜底顺序 ============ */

/** @param {any} value @returns {number | null} */
export function num(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** @param {any} value @returns {number | null} */
export function int(value) {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

/** @param {any} value @returns {string} */
export function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** @param {any} value @returns {boolean} */
export function boolOf(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * 秒/毫秒/ISO 字符串都收。无时区的 ISO 按 UTC 解，与 Python
 * `datetime.fromisoformat(...).replace(tzinfo=utc)` 保持一致。
 * @param {any} value
 * @returns {number}
 */
export function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return 0;
    if (/^-?\d+$/.test(text)) return epochMs(Number(text));
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const parsed = Date.parse(hasZone ? text : `${text}Z`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** @param {any} value @returns {Record<string, any>} */
export function objectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @param {...any} values @returns {Record<string, any>} */
export function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (Array.isArray(value) && value.length && value[0] && typeof value[0] === "object") {
      return value[0];
    }
  }
  return {};
}

/** @param {Record<string, any>} mapping @param {string[]} names @returns {any} */
export function pick(mapping, names) {
  for (const name of names) {
    if (Object.hasOwn(mapping, name)) return mapping[name];
  }
  return undefined;
}

/**
 * 凭据掩码：照 goat-gauge credentials.mask_key 的前缀族 + 后 4 位；
 * 短 Key 全部打码（派单要求）。
 * @param {unknown} value
 * @returns {string}
 */
export function maskKey(value) {
  const key = str(value);
  if (!key) return "未配置";
  if (key.length <= 8) return "*****";
  const lower = key.toLowerCase();
  const prefix = ["cc-", "sk-", "user-", "key-"].find((p) => lower.startsWith(p)) ?? "";
  return `${prefix}*****${key.slice(-4)}`;
}

/* ============ 窗口 / 用量 / 凭据 ============ */

/**
 * @param {any} raw
 * @param {{ kind: string, label: string, limited: boolean }} options
 * @returns {Record<string, any>}
 */
export function normalizeWindow(raw, { kind, label, limited }) {
  const source = objectOf(raw);
  if (!Object.keys(source).length) {
    return {
      kind,
      label,
      used: null,
      cap: null,
      remaining: null,
      remaining_pct: null,
      exceeded: false,
      reset_at: 0,
      available: false,
      note: limited ? "服务端暂未返回该窗口" : "当前套餐不受此窗口限制",
    };
  }

  const used = num(pick(source, ["used", "usage", "usedCredits", "used_credits"]));
  const cap = num(pick(source, ["cap", "limit", "capCredits", "cap_credits"]));
  const exceeded =
    boolOf(pick(source, ["exceeded", "isExceeded", "is_exceeded"])) ||
    (used !== null && cap !== null && cap > 0 && used >= cap);
  const resetAt = epochMs(pick(source, ["resetAt", "reset_at", "resetsAt", "resets_at"]));
  const available = limited && used !== null && cap !== null && cap > 0;
  const note = available
    ? ""
    : limited
      ? "服务端暂未返回完整额度"
      : "当前套餐不受此窗口限制";
  const remaining = available ? Math.max(cap - used, 0) : null;
  const remainingPct =
    remaining !== null && cap ? Math.max(0, Math.min(100, (remaining / cap) * 100)) : null;

  return {
    kind,
    label,
    used: used ?? null,
    cap: cap ?? null,
    remaining,
    remaining_pct: remainingPct,
    exceeded,
    reset_at: resetAt,
    available,
    note,
  };
}

/** @param {any} raw @returns {Record<string, any>} */
export function normalizeUsage(raw) {
  const root = objectOf(raw);
  const data = objectOf(root.data);
  const source = Object.keys(data).length ? data : root;
  let successRate = num(pick(source, ["successRate", "success_rate"]));
  if (successRate !== null && successRate <= 1) successRate *= 100;
  return {
    total_count: int(pick(source, ["totalCount", "total_count"])) ?? 0,
    total_cost: num(pick(source, ["totalCost", "total_cost"])) ?? 0,
    average_cost: num(pick(source, ["averageCost", "average_cost"])),
    success_rate: successRate ?? 0,
    completed_count: int(pick(source, ["completedCount", "completed_count"])) ?? 0,
    failed_count: int(pick(source, ["failedCount", "failed_count"])) ?? 0,
    tokens_in: int(pick(source, ["totalTokensIn", "total_tokens_in"])) ?? 0,
    tokens_out: int(pick(source, ["totalTokensOut", "total_tokens_out"])) ?? 0,
    total_credits: num(pick(source, ["totalCredits", "total_credits"])) ?? 0,
    period_basis: str(pick(source, ["periodBasis", "period_basis"])),
  };
}

/**
 * @param {any} raw
 * @returns {{credits: Record<string, any>, limits: Record<string, any>}}
 */
export function normalizeCredits(raw) {
  const root = objectOf(raw);
  const data = objectOf(root.data);
  const source = Object.keys(data).length ? data : root;
  const limits = objectOf(source.windowLimits);
  return {
    credits: objectOf(source.credits),
    limits: Object.keys(limits).length ? limits : objectOf(source.window_limits),
  };
}

/** @param {any} raw @returns {Record<string, any>} */
export function normalizeSubscription(raw) {
  const root = objectOf(raw);
  return firstObject(root.data, root.subscription, root);
}

/* ============ 组装 Snapshot（纯函数，网络在 api.js） ============ */

/**
 * @param {{
 *   whoami?: any,
 *   creditsRoot?: any,
 *   subscriptionRoot?: any,
 *   summaryRoot?: any,
 *   apiKey?: string,
 *   fetchedAt?: number,
 *   previousUsage?: Record<string, any> | null,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildSnapshot({
  whoami = {},
  creditsRoot = {},
  subscriptionRoot = {},
  summaryRoot = {},
  apiKey = "",
  fetchedAt = Date.now(),
  previousUsage = null,
} = {}) {
  const whoamiRoot = objectOf(whoami);
  const user = objectOf(whoamiRoot.user);
  const org = objectOf(whoamiRoot.org);
  const orgId = str(org.id);

  const { credits: creditsRaw, limits } = normalizeCredits(creditsRoot);
  const subscription = normalizeSubscription(subscriptionRoot);
  const planId =
    str(pick(subscription, ["planId", "plan_id"])) ||
    str(pick(creditsRaw, ["planId", "plan_id"]));
  const known = planInfo(planId);
  const planName = known ? known.name : planId || "未知套餐";
  const monthlyCap = known ? known.monthlyCredits : null;

  const monthlyRemaining = num(pick(creditsRaw, ["monthlyCredits", "monthly_credits"]));
  const purchased = num(pick(creditsRaw, ["purchasedCredits", "purchased_credits"])) ?? 0;
  const free = num(pick(creditsRaw, ["freeCredits", "free_credits"])) ?? 0;
  const limitedRaw = limits.limited;
  const windowLimited = limitedRaw === null || limitedRaw === undefined ? true : boolOf(limitedRaw);

  const fiveHour = normalizeWindow(pick(limits, ["fiveHour", "five_hour", "rolling5h", "5h"]), {
    kind: "five_hour",
    label: "5 小时",
    limited: windowLimited,
  });
  const weekly = normalizeWindow(pick(limits, ["weekly", "week"]), {
    kind: "weekly",
    label: "本周",
    limited: windowLimited,
  });

  const periodEnd = epochMs(pick(subscription, ["currentPeriodEnd", "current_period_end"]));
  let monthly;
  if (monthlyCap !== null && monthlyRemaining !== null) {
    const monthlyUsed = Math.max(0, Math.min(monthlyCap, monthlyCap - monthlyRemaining));
    monthly = {
      kind: "monthly",
      label: "本月",
      used: monthlyUsed,
      cap: monthlyCap,
      remaining: Math.max(0, monthlyRemaining),
      remaining_pct: Math.max(0, Math.min(100, (monthlyRemaining / monthlyCap) * 100)),
      exceeded: monthlyUsed >= monthlyCap,
      reset_at: periodEnd,
      available: true,
      note: "",
    };
  } else {
    monthly = {
      kind: "monthly",
      label: "本月",
      used: null,
      cap: null,
      remaining: monthlyRemaining,
      remaining_pct: null,
      exceeded: false,
      reset_at: periodEnd,
      available: false,
      note:
        monthlyRemaining !== null
          ? `剩余 ${String(monthlyRemaining)} credits；未知套餐不推算上限`
          : "服务端暂未返回月余额",
    };
  }

  const accountName =
    str(user.userName) || str(user.username) || str(user.name) || str(org.login) || "Command Code";
  const studioSlug = str(org.login) || str(user.userName) || "";
  const studioUrl = studioSlug
    ? `https://commandcode.ai/${encodeURIComponent(studioSlug)}/settings/usage`
    : "https://commandcode.ai/settings/usage";

  const alerts = [];
  const limitedWindow = str(limits.exceeded);
  if (limitedWindow) alerts.push({ level: "danger", message: `当前受限窗口：${limitedWindow}` });
  if (fiveHour.exceeded) {
    alerts.push({ level: "danger", message: "5 小时额度已用尽，请等待窗口重置。" });
  }
  if (weekly.exceeded) alerts.push({ level: "danger", message: "本周额度已用尽，请等待周额度重置。" });
  if (monthly.exceeded) alerts.push({ level: "danger", message: "本月额度已用尽。" });
  if (boolOf(pick(creditsRaw, ["belowThreshold", "below_threshold"]))) {
    alerts.push({ level: "warning", message: "账户余额已低于预警阈值。" });
  }
  if (boolOf(pick(subscription, ["cancelAtPeriodEnd", "cancel_at_period_end"]))) {
    alerts.push({ level: "warning", message: "订阅将在当前账期结束后取消。" });
  }
  if (subscription.pendingPhase) {
    alerts.push({ level: "info", message: "账户存在待生效的套餐变更。" });
  }

  const summary = objectOf(summaryRoot);
  const usage = Object.keys(summary).length
    ? normalizeUsage(summary)
    : previousUsage
      ? { ...previousUsage }
      : normalizeUsage({});

  return {
    fetched_at: fetchedAt,
    account: {
      name: accountName,
      user_name: str(user.userName) || str(user.username),
      user_id: str(user.id),
      org_id: orgId,
      org_login: str(org.login),
      masked_key: maskKey(apiKey),
    },
    plan: {
      plan_id: planId,
      name: planName,
      status: str(subscription.status),
      monthly_credits: monthlyCap,
      current_period_start: epochMs(
        pick(subscription, ["currentPeriodStart", "current_period_start"]),
      ),
      current_period_end: periodEnd,
      cancel_at_period_end: boolOf(
        pick(subscription, ["cancelAtPeriodEnd", "cancel_at_period_end"]),
      ),
    },
    credits: {
      monthly_remaining: monthlyRemaining,
      purchased,
      free,
      below_threshold: boolOf(pick(creditsRaw, ["belowThreshold", "below_threshold"])),
      credit_threshold: num(pick(creditsRaw, ["creditThreshold", "credit_threshold"])),
    },
    windows: { five_hour: fiveHour, weekly, monthly },
    usage,
    alerts,
    studio_url: studioUrl,
  };
}

/* ============ P1（Cookie/明细）用的纯函数，先按源码移植 ============ */

/** @param {any} raw @returns {Record<string, any> | null} */
export function normalizeUsageRecord(raw) {
  const source = objectOf(raw);
  const recordId = str(source.id);
  const createdAt = str(source.createdAt);
  if (!recordId || !createdAt) return null;
  const meta = objectOf(source.meta);
  return {
    id: recordId,
    created_at: createdAt,
    model: str(meta.model) || "unknown",
    provider: "",
    tokens_in: int(source.tokensIn) ?? 0,
    tokens_out: int(source.tokensOut) ?? 0,
    cost_total: num(meta.totalCost) ?? 0,
    cost_input: num(meta.inputCost) ?? 0,
    cost_output: num(meta.outputCost) ?? 0,
    cost_cache: num(meta.cacheCost) ?? 0,
    duration_ms: int(source.durationTotal) ?? 0,
    status: str(source.status),
    entry_type: str(source.type),
    mode: str(source.mode),
    trace_id: str(meta.traceId),
  };
}

/** @param {any} raw @returns {Record<string, any> | null} */
export function normalizeChartBucket(raw) {
  const source = objectOf(raw);
  const model = str(source.model);
  const bucket = str(source.timeBucket);
  if (!model || !bucket) return null;
  return {
    model,
    provider: str(source.provider),
    time_bucket: bucket,
    requests: int(source.requests) ?? 0,
    tokens_in: int(pick(source, ["tokensIn", "tokens_in"])) ?? 0,
    tokens_out: int(pick(source, ["tokensOut", "tokens_out"])) ?? 0,
    tokens_total: int(pick(source, ["tokensTotal", "tokens_total"])) ?? 0,
    cache_read_tokens:
      int(pick(source, ["cacheReadInputTokens", "cache_read_input_tokens"])) ?? 0,
    cache_write_tokens:
      int(pick(source, ["cacheCreationInputTokens", "cache_creation_input_tokens"])) ?? 0,
    cost_total: num(pick(source, ["totalCost", "total_cost"])) ?? 0,
    cost_cache: num(pick(source, ["cacheCost", "cache_cost"])) ?? 0,
    cache_savings: num(pick(source, ["cacheSavings", "cache_savings"])) ?? 0,
  };
}
