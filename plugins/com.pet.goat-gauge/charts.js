// 纯几何：圆环弧线与折线点。不碰 ctx/DOM，单测可直接断言。
// SVG 契约没有 stroke-dasharray/文本元素，所以进度用 path 的 d 手算，
// 标签由视图用 HTML span 渲染。

/** @param {unknown} value @returns {number} */
export function clampPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/** @param {number} pct @returns {"good" | "warn" | "bad"} */
export function toneOfPct(pct) {
  const n = clampPct(pct);
  return n > 50 ? "good" : n >= 20 ? "warn" : "bad";
}

function polar(cx, cy, r, degrees) {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/**
 * 从 12 点顺时针画 pct% 的圆弧。pct<=0 给一个不画的 move。
 * @param {number} cx @param {number} cy @param {number} r @param {number} pct
 * @returns {string}
 */
export function arcPath(cx, cy, r, pct) {
  const value = clampPct(pct);
  if (value <= 0) return `M ${cx} ${cy}`;
  if (value >= 100) {
    const [x0, y0] = polar(cx, cy, r, 0);
    const [x1, y1] = polar(cx, cy, r, 180);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 1 1 ${x0.toFixed(2)} ${y0.toFixed(2)}`;
  }
  const [x0, y0] = polar(cx, cy, r, 0);
  const [x1, y1] = polar(cx, cy, r, value * 3.6);
  const large = value > 50 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * 历史点 → SVG polyline points。fieldIndex 对应 history.js 的紧凑数组：
 * 1=fivePct, 2=weeklyPct, 3=monthlyRemaining。
 * @param {Array<Array<number | null>>} rows
 * @param {number} fieldIndex
 * @param {{ width: number, height: number, start: number, end: number, min?: number, max?: number }} options
 * @returns {string}
 */
export function polylinePoints(rows, fieldIndex, { width, height, start, end, min = 0, max = 100 }) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const span = Math.max(1, Number(end) - Number(start));
  const lo = Number(min);
  const hi = Number(max);
  const range = Math.max(1e-9, hi - lo);
  const points = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const t = Number(row[0]);
    const value = Number(row[fieldIndex]);
    if (!Number.isFinite(t) || !Number.isFinite(value)) continue;
    const x = Math.max(0, Math.min(width, ((t - Number(start)) / span) * width));
    const y = height - Math.max(0, Math.min(1, (value - lo) / range)) * height;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

/** @param {Array<Array<number | null>>} rows @param {number} fieldIndex @param {number} fallback */
export function maxValue(rows, fieldIndex, fallback = 100) {
  let max = 0;
  for (const row of rows ?? []) {
    const value = Number(row?.[fieldIndex]);
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return max > 0 ? max : fallback;
}
