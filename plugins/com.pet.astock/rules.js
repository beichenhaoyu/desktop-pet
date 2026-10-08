// 提醒判定：纯函数，不碰网络也不碰 ctx，回归脚本可以直接 import 断言。
//
// 两类规则：
//   用户设的：upper（涨到）/ lower（跌到）/ pct（涨跌幅绝对值，正负都算）
//   市场本身：limit_up / limit_down —— 涨跌停用「现价 == 最高/最低 且 幅度到限制」判，
//             停牌与集合竞价阶段因为价格还没连续成交，交给 quoteAt 是否前进来挡（见 index.js）
//
// 去重口径与待办插件一致：一条规则一天只提醒一次，键记在 alerted 里。

import { limitPct } from "./market.js";

export const KINDS = ["upper", "lower", "pct", "limitUp", "limitDown"];

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 一条自选股的规则摘要，用于界面上说明「这只在盯什么」 */
export function ruleSummary(item) {
  const parts = [];
  if (num(item.upper) !== null) parts.push(`≥${item.upper}`);
  if (num(item.lower) !== null) parts.push(`≤${item.lower}`);
  if (num(item.pct) !== null) parts.push(`|涨跌|≥${item.pct}%`);
  if (item.limit) parts.push("涨跌停");
  return parts.length ? parts.join(" ") : "未设提醒";
}

/**
 * 求值一轮：返回应当提醒的条目。
 * @param quotes  本轮行情（secid → quote）
 * @param watch   自选股列表 [{secid, code, name, upper, lower, pct, limit}]
 * @param alerted 已提醒记录 { "2026-10-08:600519:upper": true }
 * @param today   YYYY-MM-DD，用于按日去重
 */
export function evalAlerts({ quotes, watch, alerted, today }) {
  const hits = [];
  for (const item of watch ?? []) {
    const q = quotes?.[item.secid];
    if (!q || q.price === null) continue;
    const price = num(q.price);
    const pct = num(q.pct);
    const push = (kind, message, level) => {
      const key = `${today}:${item.code}:${kind}`;
      if (alerted[key]) return;
      hits.push({ key, kind, secid: item.secid, code: item.code, name: q.name || item.name, message, level, at: Date.now() });
    };

    const upper = num(item.upper);
    if (upper !== null && price >= upper) {
      push("upper", `${q.name || item.name} 涨到 ${price.toFixed(2)}（阈值 ${upper.toFixed(2)}）`, "up");
    }
    const lower = num(item.lower);
    if (lower !== null && price <= lower) {
      push("lower", `${q.name || item.name} 跌到 ${price.toFixed(2)}（阈值 ${lower.toFixed(2)}）`, "down");
    }
    const pctMax = num(item.pct);
    if (pctMax !== null && pct !== null && Math.abs(pct) >= pctMax) {
      push(
        "pct",
        `${q.name || item.name} 已${pct >= 0 ? "涨" : "跌"} ${Math.abs(pct).toFixed(2)}%（阈值 ${pctMax}%）`,
        pct >= 0 ? "up" : "down",
      );
    }
    if (item.limit !== false) {
      const lim = limitPct(item.code);
      const high = num(q.high);
      const low = num(q.low);
      // 顶到最高价且幅度接近限制 → 视为封板；跌停同理
      if (pct !== null && pct >= lim - 0.05 && high !== null && price >= high - 1e-6) {
        push("limitUp", `${q.name || item.name} 涨停 ${price.toFixed(2)}`, "up");
      } else if (pct !== null && pct <= -(lim - 0.05) && low !== null && price <= low + 1e-6) {
        push("limitDown", `${q.name || item.name} 跌停 ${price.toFixed(2)}`, "down");
      }
    }
  }
  return hits;
}

/** 提醒落定后把键写回去重表；顺带丢掉非今天的历史键，不让它无限长大 */
export function markAlerted(alerted, hits, today) {
  for (const hit of hits) alerted[hit.key] = true;
  for (const key of Object.keys(alerted)) {
    if (!key.startsWith(`${today}:`)) delete alerted[key];
  }
  return alerted;
}
