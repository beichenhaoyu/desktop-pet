// 东方财富源：行情/搜索/五档/K线/分时的 URL 构造、响应解析与列序映射。
// 原 market.js 的东财部分按源拆出，口径逐字未动（五档要省略 fields、klt=102/103 退化为日K 等坑见各处原注释）。

import { epochMsOfSeconds, isNum, MAX_KLINE_BARS, MAX_SECIDS } from "../market.js";
import { limitOf, UA_HEADERS } from "./tencent.js";

export const QUOTE_API = "https://push2.eastmoney.com/api/qt/ulist.np/get";
export const SUGGEST_API = "https://searchadapter.eastmoney.com/api/suggest/get";
export const DETAIL_API = "https://push2.eastmoney.com/api/qt/stock/get";
export const KLINE_API = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
export const TREND_API = "https://push2his.eastmoney.com/api/qt/stock/trends2/get";

/** 接口字段：f12 代码 f13 市场 f14 名称 f2 最新价 f3 涨跌幅 f4 涨跌额 f5 成交量
 *  f6 成交额 f15 高 f16 低 f17 今开 f18 昨收 f124 行情时间戳 */
const QUOTE_FIELDS = "f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124";

export function buildQuoteUrl(secids) {
  const list = [...new Set(secids.filter(Boolean))].slice(0, MAX_SECIDS);
  return `${QUOTE_API}?secids=${encodeURIComponent(list.join(","))}&fields=${QUOTE_FIELDS}&fltt=2&invt=2`;
}

/** 东财停牌/无数据时会把数值位打成 "-" 或直接缺字段：一律落成 null，别让 NaN 流进比较 */
export function num(v) {
  return isNum(v) ? v : null;
}

export function parseQuoteRow(row) {
  if (!row || typeof row !== "object") return null;
  const code = typeof row.f12 === "string" ? row.f12 : null;
  const market = isNum(row.f13) ? row.f13 : null;
  if (!code || market === null) return null;
  return {
    secid: `${market}.${code}`,
    code,
    name: typeof row.f14 === "string" ? row.f14 : code,
    price: num(row.f2),
    pct: num(row.f3),
    change: num(row.f4),
    volume: num(row.f5),
    amount: num(row.f6),
    high: num(row.f15),
    low: num(row.f16),
    open: num(row.f17),
    prevClose: num(row.f18),
    // 东财的快照字段表里没有涨跌停（f51/f52 只在 stock/get 那条详情里）→ 留 null，由五档那一路补
    limitUp: null,
    limitDown: null,
    /** 行情时间戳：**epoch 毫秒**（f124 是秒，乘 1000；见 epochMsOfSeconds） */
    quoteAt: epochMsOfSeconds(row.f124),
  };
}

export function parseQuoteResponse(json) {
  const diff = json?.data?.diff;
  const rows = Array.isArray(diff) ? diff : Object.values(diff ?? {});
  return rows.map(parseQuoteRow).filter(Boolean);
}

/** suggest 响应：CodeTable 里每条给 Code / Name / MarketType / SecurityTypeName */
export function parseSuggestResponse(json) {
  const rows = json?.QuotationCodeTable?.Data;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.Code === "string" && /^\d{6}$/.test(r.Code))
    .slice(0, 12)
    .map((r) => ({
      code: r.Code,
      name: typeof r.Name === "string" ? r.Name : r.Code,
      // 接口给的 MktNum 就是市场号，优先信它，比自己按首位猜准
      secid: `${isNum(Number(r.MktNum)) ? Number(r.MktNum) : r.MktNum}.${r.Code}`,
      type: typeof r.SecurityTypeName === "string" ? r.SecurityTypeName : "",
    }));
}

export function buildSuggestUrl(keyword) {
  const q = encodeURIComponent(String(keyword ?? "").trim().slice(0, 32));
  return `${SUGGEST_API}?input=${q}&type=14&count=10`;
}

/* ================= 明细（五档盘口）/ 分时 / K线 ================= */

/**
 * 盘口与涨跌停的字段口径，2026-10-09 用腾讯 qt.gtimg.cn 的盘口逐档对过（GBK 解码后取值），
 * 五个价位的五个量全部一致才写下来：
 *   买一 f19/f20、买二 f17/f18、买三 f15/f16、买四 f13/f14、买五 f11/f12
 *   卖一 f39/f40、卖二 f37/f38、卖三 f35/f36、卖四 f33/f34、卖五 f31/f32（价在前量在后，量单位是手）
 *   涨停 f51、跌停 f52、均价 f71、昨收 f60
 * f51/f52 是**交易所给的委托限价**而不是百分比：实测主板 ±10%、创业板/科创板 ±20%、北交所 920xxx ±30%，
 * 比按代码前缀猜准确（但 ST 仍拿到的是 ±10%，这一档判不准，见插件页的说明）。
 *
 * URL 必须**省略 fields 参数**：显式点名 f11–f20 / f31–f40 时接口会静默丢掉它们
 * （实测 `fields=f43,f11,f12,f19,f20` 只回 f43），而不带 fields 时默认全集里五档齐全（约 935 字节）。
 */
const BID_FIELDS = [19, 17, 15, 13, 11];
const ASK_FIELDS = [39, 37, 35, 33, 31];

export function buildDetailUrl(secid) {
  return `${DETAIL_API}?secid=${encodeURIComponent(secid)}&invt=2&fltt=2`;
}

/**
 * 一档盘口。停牌/竞价阶段接口会给出「价格是 - 但量是数字」的半截档（实测 2026-10-09 09:16 的买二），
 * 那种档在界面上没法读，也没法参与比较 —— 没有价格就当整档是空的。
 */
function levelOf(data, priceField) {
  const price = num(data[`f${priceField}`]);
  return { price, volume: price === null ? null : num(data[`f${priceField + 1}`]) };
}

export function parseDepthResponse(json, secid = "") {
  const d = json?.data;
  // 解不出来就**判失败**（抛），别回一个空盘口当成功：多源链要靠这个下移，
  // 否则一次形状变化会静默把盘口变成「没有盘口数据」。停牌标的的 f57 仍在（只是价为 "-"），
  // 所以这里挡掉的确实是「这只没数据」而不是「这只今天没成交」。
  if (!d || typeof d.f57 !== "string") throw new Error(`${secid || "该标的"} 的盘口没解出来`);
  return {
    secid,
    code: d.f57,
    name: typeof d.f58 === "string" ? d.f58 : d.f57,
    price: num(d.f43),
    prevClose: num(d.f60),
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    volume: num(d.f47),
    amount: num(d.f48),
    avgPrice: num(d.f71),
    // 涨跌停 ≤0 落 null（腾讯那边用 -1 表示不供，东财这条按同样口径收口）
    limitUp: limitOf(d.f51),
    limitDown: limitOf(d.f52),
    /** 买盘从买一到买五、卖盘从卖一到卖五，界面按「卖上买下」的老习惯排 */
    bids: BID_FIELDS.map((f) => levelOf(d, f)),
    asks: ASK_FIELDS.map((f) => levelOf(d, f)),
  };
}

export const KLINE_PERIODS = [
  { klt: 101, label: "日K" },
  { klt: 60, label: "60分" },
  { klt: 30, label: "30分" },
  { klt: 15, label: "15分" },
  { klt: 5, label: "5分" },
];

// 周K/月K 不在表里：实测 klt=102/103 与 101 返回完全相同的内容和 dktotal，
// 也就是这个公开接口并没有真的按周/月聚合，放进去只会让人以为图是错的。
export const KLT_VALUES = KLINE_PERIODS.map((p) => p.klt);

export function buildKlineUrl(secid, klt = 101, count = MAX_KLINE_BARS) {
  const bars = Math.max(10, Math.min(MAX_KLINE_BARS, Math.round(count) || MAX_KLINE_BARS));
  const period = KLT_VALUES.includes(klt) ? klt : 101;
  return (
    `${KLINE_API}?secid=${encodeURIComponent(secid)}&klt=${period}&fqt=1&lmt=${bars}` +
    `&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  );
}

/**
 * 分时与 K 线共用「f51 时间、f52 开、f53 收、f54 高、f55 低、f56 量(手)、f57 额」这段列序，
 * 但**最后一列含义不同**：K 线的 f58 是换手率，分时的 f58 是当日累计均价。
 * 这个坑是实测出来的（分时末列 1249.788 对上了「成交额/成交量」的均价），别顺手当成同一列复用。
 */
function splitCsvLine(line) {
  return String(line ?? "").split(",");
}

export function parseKlineResponse(json) {
  const rows = Array.isArray(json?.data?.klines) ? json.data.klines : [];
  const bars = rows
    .map((line) => {
      const p = splitCsvLine(line);
      return {
        time: p[0] ?? "",
        open: Number(p[1]),
        close: Number(p[2]),
        high: Number(p[3]),
        low: Number(p[4]),
        volume: Number(p[5]),
        amount: Number(p[6]),
        turnover: Number(p[7]),
      };
    })
    .filter((b) => b.time && Number.isFinite(b.open) && Number.isFinite(b.close));
  return { bars, preKPrice: num(json?.data?.preKPrice) };
}

export function buildTrendUrl(secid) {
  return (
    `${TREND_API}?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`
  );
}

export function parseTrendResponse(json) {
  const rows = Array.isArray(json?.data?.trends) ? json.data.trends : [];
  // 分时点很密（一天 241 个），只保留画图要的：时刻、价（每分钟收）、均价、量
  const points = rows
    .map((line) => {
      const p = splitCsvLine(line);
      return {
        time: (p[0] ?? "").slice(11),
        price: Number(p[2]),
        volume: Number(p[5]),
        avg: Number(p[7]),
      };
    })
    .filter((pt) => pt.time && Number.isFinite(pt.price));
  const preClose = num(json?.data?.preClose);
  return { points, preClose };
}

export const EASTMONEY_HEADERS = [...UA_HEADERS, ["referer", "https://quote.eastmoney.com/"]];
