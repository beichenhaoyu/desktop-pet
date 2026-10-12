// 提醒判定：纯函数，不碰网络也不碰 ctx，回归脚本可以直接 import 断言。
//
// 两类规则：
//   用户设的：upper（涨到）/ lower（跌到）/ pct（涨跌幅绝对值，正负都算）
//   市场本身：limitUp / limitDown —— 优先用交易所给的涨跌停**价**判（腾讯 47/48 段、东财 f51/f52）；
//             该源不供价时才回落到「现价 == 最高/最低 且 幅度到按代码前缀猜的限制」。停牌与
//             集合竞价阶段因为价格还没连续成交，交给 quoteAt 是否前进来挡（见 index.js）
//
// 去重口径与待办插件一致：一条规则一天只提醒一次，键记在 alerted 里。

import { limitPct } from "./market.js";

export const KINDS = ["upper", "lower", "pct", "limitUp", "limitDown"];

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 涨跌停价：只认正数；-1 / 0（该源这次不供的标记，见 AGENTS.md 腾讯字段口径）与非法值一律落 null，绝不参与比较 */
function limitPrice(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
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
      const high = num(q.high);
      const low = num(q.low);
      // 交易所价优先：腾讯 47/48 段、东财 f51/f52 给的是**价**，有价就按价判 ——
      // pct 与"顶在当日最高/最低"都不再是必要条件（昨收异常时 pct 可能为 null）
      const upPrice = limitPrice(q.limitUp);
      const downPrice = limitPrice(q.limitDown);
      if (upPrice !== null && price >= upPrice - 1e-6) {
        push("limitUp", `${q.name || item.name} 涨停 ${price.toFixed(2)}`, "up");
      } else if (downPrice !== null && price <= downPrice + 1e-6) {
        push("limitDown", `${q.name || item.name} 跌停 ${price.toFixed(2)}`, "down");
      } else if (upPrice === null && downPrice === null) {
        // 该源不供价（东财批量快照 / 新浪 / -1、0 这类不供标记）→ 回落到按代码前缀猜的幅度
        const lim = limitPct(item.code);
        if (pct !== null && pct >= lim - 0.05 && high !== null && price >= high - 1e-6) {
          push("limitUp", `${q.name || item.name} 涨停 ${price.toFixed(2)}`, "up");
        } else if (pct !== null && pct <= -(lim - 0.05) && low !== null && price <= low + 1e-6) {
          push("limitDown", `${q.name || item.name} 跌停 ${price.toFixed(2)}`, "down");
        }
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
