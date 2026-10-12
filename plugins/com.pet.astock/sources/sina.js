// 新浪源：快照（hq.sinajs.cn）的 URL 构造与解析。原 market.js 的新浪部分按源拆出，口径逐字未动。
// 量从股换算成手、必须带 referer、无涨跌停字段、不供五档（只做价格兜底）——依据见各段原注释。

import { changeOf, epochMsOfDateTime, pctOf } from "../market.js";
import { qnum, requireQuoteRows, secidOfTencentCode, splitQuoteLines, UA_HEADERS } from "./tencent.js";

/**
 * 新浪快照 `hq.sinajs.cn/list=<代码逗号连接>`，2026-10-10 实测：
 *   带 `referer: https://finance.sina.com.cn` → 200、`charset=GB18030`；**不带 → 403**（所以它的头单独一套）。
 *   每只一行 `var hq_str_<代码>="…"`，逗号分隔（沪 34 段、北交所 39 段，前 32 段布局一致）：
 *     0 名称 1 今开 2 昨收 3 现价 4 最高 5 最低 8 成交量(**股**) 9 成交额(元) 30 日期 31 时间
 *   量是**股**：实测 94795849 股 ÷ 100 = 947958.49 → 四舍五入 = 947958 手，与腾讯段 6 一致
 *     （sz300750 54152671 → 541527 ✓、bj920185 12513513 → 125135 ✓），所以解析时就换算成手，
 *     对外与腾讯/东财同一个口径。
 *   **不接五档**：它在盘口上不可靠 —— 规划方 2026-10-09 15:23 实测同一时刻腾讯给满五档而新浪
 *     12..29 段全是 0（收盘前后会清空）；本机 2026-10-10 08:3x 再测时 10..29 又有值，
 *     说明它随时段变，不能当五档后端。只做价格兜底，且它**没有涨跌停字段** → 那两栏留 null。
 */
export const SINA_QUOTE_API = "https://hq.sinajs.cn/list=";
const SINA_COL = { name: 0, open: 1, prevClose: 2, price: 3, high: 4, low: 5, volumeShares: 8, amount: 9, date: 30, time: 31 };

export function buildSinaQuoteUrl(codes) {
  return `${SINA_QUOTE_API}${codes.join(",")}`;
}

/** 新浪快照 → 内部行情结构；量从股换算成手（与腾讯/东财同口径），涨跌停字段这个源没有 */
export function parseSinaQuotes(body) {
  const rows = splitQuoteLines(body, ",", "hq_str_")
    .map(({ code, seg }) => {
      const secid = secidOfTencentCode(code);
      if (!secid) return null;
      const price = qnum(seg[SINA_COL.price]);
      const prevClose = qnum(seg[SINA_COL.prevClose]);
      const shares = qnum(seg[SINA_COL.volumeShares]);
      const rawName = String(seg[SINA_COL.name] ?? "").trim();
      if (!rawName && price === null) return null; // 空串行（不存在的代码）不算一行，理由同腾讯那边
      return {
        secid,
        code,
        name: rawName || code,
        price,
        pct: pctOf(price, prevClose),
        change: changeOf(price, prevClose),
        volume: shares === null ? null : Math.round(shares / 100), // 股 → 手
        amount: qnum(seg[SINA_COL.amount]),
        high: qnum(seg[SINA_COL.high]),
        low: qnum(seg[SINA_COL.low]),
        open: qnum(seg[SINA_COL.open]),
        prevClose,
        // 新浪没有涨跌停字段（实测 34 段里没有这两个价）→ 留 null，界面显示「该源不供」
        limitUp: null,
        limitDown: null,
        quoteAt: epochMsOfDateTime(seg[SINA_COL.date], seg[SINA_COL.time]),
      };
    })
    .filter(Boolean);
  return requireQuoteRows(rows);
}

export const SINA_HEADERS = [...UA_HEADERS, ["referer", "https://finance.sina.com.cn"]];
