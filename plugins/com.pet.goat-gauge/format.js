// 展示层格式化：纯函数，不碰 ctx / DOM。credits 与金额是两种口径：
// 额度单位是 credits，切币种不换算；只有 cost_* 字段按 USD→CNY 换算。

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
export function clampNumber(value, min, max, fallback) {
  return isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** 额度值（credits）：不换算，最多两位小数。 */
export function fmtCredits(value) {
  if (!isFiniteNumber(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** 金额：只有 cost 字段走汇率，credits 不经过这里。 */
export function fmtMoney(value, { currency = "USD", usdToCny = 7.2 } = {}) {
  if (!isFiniteNumber(value)) return "—";
  const rate = isFiniteNumber(usdToCny) && usdToCny > 0 ? usdToCny : 7.2;
  const amount = currency === "CNY" ? value * rate : value;
  const prefix = currency === "CNY" ? "¥" : "$";
  return `${prefix}${amount.toFixed(2)}`;
}

/** token 数：k/M 缩写，保留一位小数并去掉 .0。 */
export function fmtTokens(value) {
  if (!isFiniteNumber(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

/** 剩余百分比：整数，用于 badge / 环。 */
export function fmtPct(value) {
  return isFiniteNumber(value) ? `${Math.round(value)}%` : "—";
}

/** 倒计时固定 h:mm（小时可以超过 24；周窗口也用它）。 */
export function fmtCountdown(ms, now = Date.now()) {
  const remain = Math.max(0, Number(ms) - Number(now));
  const totalMinutes = Math.floor(remain / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/** 本地日期时间，避免把 ISO 字符串直接怼进界面。 */
export function fmtDateTime(ms) {
  if (!isFiniteNumber(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtCurrency(currency) {
  return currency === "CNY" ? "CNY" : "USD";
}
