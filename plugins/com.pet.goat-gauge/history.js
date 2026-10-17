// 本地历史：5 分钟采样、48 小时窗口、最多 576 点。存储用紧凑数组，
// 宿主 store 每次整表读写，所以这里只返回新数组，写不写由 main 决定。
export const SAMPLE_INTERVAL_MS = 300_000;
export const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;
export const MAX_HISTORY_POINTS = 576;

/** [t, fivePct, weeklyPct, monthlyRemaining, totalCost, tokensIn, tokensOut] */
export const HISTORY_FIELDS = 7;

/**
 * @param {Record<string, any> | null} snapshot
 * @param {number} now
 * @returns {Array<number | null> | null}
 */
export function samplePoint(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const five = snapshot.windows?.five_hour?.remaining_pct;
  const weekly = snapshot.windows?.weekly?.remaining_pct;
  const monthly = snapshot.windows?.monthly?.remaining;
  const usage = snapshot.usage ?? {};
  const finiteOrNull = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return [
    finiteOrNull(snapshot.fetched_at) ?? now,
    finiteOrNull(five),
    finiteOrNull(weekly),
    finiteOrNull(monthly),
    finiteOrNull(usage.total_cost),
    finiteOrNull(usage.tokens_in),
    finiteOrNull(usage.tokens_out),
  ];
}

/**
 * @param {Array<Array<number | null>>} history
 * @param {Record<string, any> | null} snapshot
 * @param {number} now
 * @param {{ sampleMs?: number, windowMs?: number, maxPoints?: number }} options
 * @returns {Array<Array<number | null>>}
 */
export function appendHistory(
  history,
  snapshot,
  now = Date.now(),
  { sampleMs = SAMPLE_INTERVAL_MS, windowMs = HISTORY_WINDOW_MS, maxPoints = MAX_HISTORY_POINTS } = {},
) {
  const point = samplePoint(snapshot, now);
  if (!point) return history;
  const last = history.at(-1);
  if (last && now - Number(last[0]) < sampleMs) return history;

  const cutoff = now - windowMs;
  const next = history.filter(
    (row) => Array.isArray(row) && Number(row[0]) >= cutoff && Number(row[0]) <= now,
  );
  next.push(point);
  return next.length > maxPoints ? next.slice(-maxPoints) : next;
}

/**
 * 本地日键。传 timeZone 只为单测可复现；正常调用不传，用机器本地时区。
 * @param {number} ms
 * @param {string | undefined} timeZone
 * @returns {string}
 */
export function localDayKey(ms, timeZone = undefined) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * 上游 charts 的桶是 UTC 时间串，落本地日汇总前先换成本地日（P1 用）。
 * @param {string} iso
 * @param {string | undefined} timeZone
 * @returns {string}
 */
export function bucketToLocalDay(iso, timeZone = undefined) {
  if (typeof iso !== "string" || !iso.trim()) return "";
  const parsed = Date.parse(iso.trim());
  return Number.isNaN(parsed) ? "" : localDayKey(parsed, timeZone);
}
