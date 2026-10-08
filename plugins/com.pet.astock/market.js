// 行情数据层：东方财富公开只读接口。
//
// 为什么是东财而不是腾讯/新浪：这两个源的实时接口回的是 GBK / GB18030，
// 而宿主的 http 代理按 UTF-8 取文本（from_utf8_lossy），中文股票名会直接变乱码；
// 新浪还要求带 Referer，缺了给 403。东财三个域都是 UTF-8 JSON、约 150ms、
// 且不跨主机重定向（宿主的 http 授权是逐跳复核域名的，跨主机 302 会被拒）。
//
// 这里刻意分成两层：纯函数（编码规则、解析、时段判定）+ 取数函数。
// 纯函数不碰网络也不碰 ctx，回归脚本可以直接 import 来断言。

export const QUOTE_API = "https://push2.eastmoney.com/api/qt/ulist.np/get";
export const SUGGEST_API = "https://searchadapter.eastmoney.com/api/suggest/get";

/// 一次批量快照最多带多少只：接口本身能吞更多，但列表太长时响应体与解析都会抖
export const MAX_SECIDS = 40;

/** 常用指数。代码与个股会撞车（000001 既是上证指数也是平安银行），所以指数只走这份预设表 */
export const INDICES = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
  { secid: "1.000688", name: "科创50" },
  { secid: "1.000300", name: "沪深300" },
  { secid: "0.899050", name: "北证50" },
];

/** 接口字段：f12 代码 f13 市场 f14 名称 f2 最新价 f3 涨跌幅 f4 涨跌额 f5 成交量
 *  f6 成交额 f15 高 f16 低 f17 今开 f18 昨收 f124 行情时间戳 */
const QUOTE_FIELDS = "f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124";

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 把用户输入归整成 6 位数字代码。
 * 接受 `600519` / `sh600519` / `600519.SH` / `SZ000001` / `1.600519`。
 */
export function normalizeCode(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  const dotted = raw.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (dotted) return dotted[1];
  const prefixed = raw.match(/^(sh|sz|bj)(\d{6})$/);
  if (prefixed) return prefixed[2];
  const secid = raw.match(/^([01])\.(\d{6})$/);
  if (secid) return secid[2];
  return /^\d{6}$/.test(raw) ? raw : null;
}

/**
 * 6 位代码 → 东财 secid（`市场.代码`）。市场号：1=沪，0=深。
 * 规则按首位收敛：沪 6/9/5 开头，深 0/1/2/3 开头；北交所走 0.8xxxxx（与指数同样需要显式指定）。
 * 认不出来时返回 null，让调用方去查 suggest 接口而不是猜。
 */
export function secidOf(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  const head = c[0];
  if (head === "6" || head === "9" || head === "5") return `1.${c}`;
  if (head === "0" || head === "1" || head === "2" || head === "3") return `0.${c}`;
  if (head === "4" || head === "8") return `0.${c}`; // 北交所（4xxxxx / 8xxxxx）
  return null;
}

/** 涨跌停幅度：创业板 30 / 科创板 68 是 20%，主板 10%。ST 的 5% 这里不区分（见 README 记录） */
export function limitPct(code) {
  const c = normalizeCode(code) ?? "";
  return c.startsWith("30") || c.startsWith("68") ? 20 : 10;
}

export function buildQuoteUrl(secids) {
  const list = [...new Set(secids.filter(Boolean))].slice(0, MAX_SECIDS);
  return `${QUOTE_API}?secids=${encodeURIComponent(list.join(","))}&fields=${QUOTE_FIELDS}&fltt=2&invt=2`;
}

/** 东财停牌/无数据时会把数值位打成 "-" 或直接缺字段：一律落成 null，别让 NaN 流进比较 */
function num(v) {
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
    /** 行情时间戳（秒）。轮询靠它判断「这轮有没有新数据」，比猜节假日可靠 */
    quoteAt: num(row.f124),
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

/**
 * A股时段（本地时间，只认星期与时钟；法定节假日不判 —— 那时行情时间戳不动，
 * 提醒逻辑靠「时间戳有没有前进」自然就不会误触发）。
 */
export function marketSession(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return { phase: "weekend", trading: false };
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 9 * 60 + 15) return { phase: "pre", trading: false };
  if (mins < 9 * 60 + 30) return { phase: "auction", trading: true };
  if (mins <= 11 * 60 + 30) return { phase: "morning", trading: true };
  if (mins < 13 * 60) return { phase: "lunch", trading: false };
  if (mins <= 15 * 60) return { phase: "afternoon", trading: true };
  return { phase: "closed", trading: false };
}

/* ================= 取数（要 http 能力，由调用方把 ctx.http.request 传进来） ================= */

const HEADERS = [
  ["referer", "https://quote.eastmoney.com/"],
  ["user-agent", "DesktopPet/0.1 (personal desktop pet plugin)"],
];

/** 统一把接口响应解成 JSON；非 2xx / 非 JSON / 被截断都抛可读错误 */
function decode(resp, what) {
  if (!resp || resp.status < 200 || resp.status >= 300) {
    throw new Error(`${what} 返回 ${resp?.status ?? "?"}`);
  }
  if (resp.truncated) throw new Error(`${what} 响应过大被截断`);
  try {
    return JSON.parse(resp.body);
  } catch {
    throw new Error(`${what} 响应不是 JSON`);
  }
}

export async function fetchQuotes(request, secids) {
  const list = [...new Set(secids.filter(Boolean))];
  if (list.length === 0) return [];
  const resp = await request(buildQuoteUrl(list), { headers: HEADERS });
  return parseQuoteResponse(decode(resp, "行情"));
}

export async function fetchSuggest(request, keyword) {
  const resp = await request(buildSuggestUrl(keyword), { headers: HEADERS });
  return parseSuggestResponse(decode(resp, "搜索"));
}
