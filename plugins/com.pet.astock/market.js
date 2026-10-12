// 行情数据层：东方财富公开只读接口（K 线与分时另有腾讯作后备源，见文末「数据源注册表」）。
//
// 为什么是东财而不是腾讯/新浪：这两个源的实时接口回的是 GBK / GB18030，
// 而宿主的 http 代理按 UTF-8 取文本（from_utf8_lossy），中文股票名会直接变乱码；
// 新浪还要求带 Referer，缺了给 403。东财三个域都是 UTF-8 JSON、约 150ms、
// 且不跨主机重定向（宿主的 http 授权是逐跳复核域名的，跨主机 302 会被拒）。
// 腾讯的 K 线与分时两条接口是 UTF-8，所以能被 K 线/分时当成第二源；实时快照那条（qt.gtimg.cn）
// 是 GBK，要等宿主 http 按 charset 解码（本体改动）之后才能接，不在这一轮里。
//
// 这里刻意分成两层：纯函数（编码规则、解析、时段判定）+ 取数函数。
// 纯函数不碰网络也不碰 ctx，回归脚本可以直接 import 来断言。

export const QUOTE_API = "https://push2.eastmoney.com/api/qt/ulist.np/get";
export const SUGGEST_API = "https://searchadapter.eastmoney.com/api/suggest/get";
export const DETAIL_API = "https://push2.eastmoney.com/api/qt/stock/get";
export const KLINE_API = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
export const TREND_API = "https://push2his.eastmoney.com/api/qt/stock/trends2/get";

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
  // 北交所新代码段 920xxx 也是 9 开头，必须排在「9 = 沪」之前判掉，
  // 否则 920185 会被拼成 1.920185（沪市）而查不到（实测贝特瑞、纬达光电都在市场 0）。
  if (c.startsWith("92")) return `0.${c}`;
  const head = c[0];
  if (head === "6" || head === "9" || head === "5") return `1.${c}`;
  if (head === "0" || head === "1" || head === "2" || head === "3") return `0.${c}`;
  if (head === "4" || head === "8") return `0.${c}`; // 北交所（4xxxxx / 8xxxxx）
  return null;
}

/** 涨跌停幅度**回落表**（只在源不供交易所涨跌停价时才用，见 rules.js；腾讯 47/48 段、
 *  东财 f51/f52 给的都是价，有价时判定不经过这里）：创业板 30 / 科创板 68 是 20%；
 *  北交所 92/4/8 开头（前缀口径与 secidOf 完全一致，别另起一份）是 30%；其余 10%。
 *  ST 的 5% 这里不区分 —— 判不出就是判不出，不假装解决（有交易所价时不受影响） */
export function limitPct(code) {
  const c = normalizeCode(code) ?? "";
  if (c.startsWith("30") || c.startsWith("68")) return 20;
  if (c.startsWith("92") || c.startsWith("4") || c.startsWith("8")) return 30;
  return 10;
}

export function buildQuoteUrl(secids) {
  const list = [...new Set(secids.filter(Boolean))].slice(0, MAX_SECIDS);
  return `${QUOTE_API}?secids=${encodeURIComponent(list.join(","))}&fields=${QUOTE_FIELDS}&fltt=2&invt=2`;
}

/** 东财停牌/无数据时会把数值位打成 "-" 或直接缺字段：一律落成 null，别让 NaN 流进比较 */
function num(v) {
  return isNum(v) ? v : null;
}

/* ================= 行情时间戳：三个源口径不同，统一成 epoch 毫秒 ================= */

/**
 * 「这一轮有没有新数据」全靠行情时间戳比大小（提醒与退避都建立在它上面），
 * 而三个源给的不是一回事：
 *   东财 f124 = **秒级** epoch（实测口径，见上面字段表）
 *   腾讯 段 30 = "20261009161457"（本地时区的 YYYYMMDDHHMMSS）
 *   新浪 段 30/31 = "2026-10-09" + "15:34:59"
 * 不归一的话，切源那一轮就是秒 vs 毫秒差 1000 倍：要么被当成「有进展」白刷一轮，
 * 要么被当成「没进展」把间隔退避到 30 分钟 —— 静默坏掉退避逻辑。
 * 所以三个解析器都从这里取时间戳，比较只认这里输出的毫秒数。
 */
export function epochMsOfSeconds(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  // 秒级 epoch 现在是 ~1.7e9，毫秒级 ~1.7e12：1e11 这条线两边都留了三个数量级余量
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function epochMsOfCompact(stamp) {
  const s = String(stamp ?? "").trim();
  if (!/^\d{14}$/.test(s)) return null;
  // 腾讯给的是本地时区的墙上时间（券商口径），按本地时间构造才是那一刻
  const t = new Date(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14)),
  ).getTime();
  return Number.isFinite(t) ? t : null;
}

export function epochMsOfDateTime(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  const c = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!d || !c) return null;
  const t = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(c[1]), Number(c[2]), Number(c[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 涨跌幅与涨跌额一律自己用现价/昨收算：休市、停牌时各家接口的自带口径不一致 */
export function pctOf(price, prevClose) {
  const p = num(price);
  const base = num(prevClose);
  if (p === null || base === null || base <= 0) return null;
  return Math.round((p / base - 1) * 10000) / 100;
}

export function changeOf(price, prevClose) {
  const p = num(price);
  const base = num(prevClose);
  if (p === null || base === null) return null;
  return Math.round((p - base) * 1000) / 1000;
}

/**
 * 「这一轮有没有新数据」+「要不要计入没进展的退避」。
 * 把时间戳归一成毫秒只是第一步：不同源对**同一时刻**的措辞差得远（实测 2026-10-09 收盘后
 * 腾讯段 30 是 16:14:57、新浪是 15:34:59，差 40 分钟），拿它们直接比大小会把「换了家源」
 * 当成「行情涨了」或「卡住了」。所以切源那一轮既不判进展、也不计入退避 —— 等下一轮同一个源再比。
 * 纯函数，回归脚本可以直接喂固定输入断言（见 verify-astock 的「时间戳归一」一组）。
 */
export function progressOf({ prevAt = 0, prevSource = "", at = 0, source = "" } = {}) {
  if (!(at > 0)) return { fresh: false, counted: false }; // 这轮没拿到时间戳（一个源都没成）
  if (prevSource && source && source !== prevSource) return { fresh: false, counted: false }; // 切源那一轮
  return { fresh: at !== prevAt, counted: true };
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

/** K 线条数上限：5 分钟线一天 48 根，120 根够看半年日线，响应约 12 KB，远在宿主 1 MiB 闸门内 */
export const MAX_KLINE_BARS = 120;

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

/* ================= 数据源注册表：K线 / 分时 ================= */

/**
 * K 线与分时为什么要有第二个源（2026-10-09 本机实测，别再自己复现一遍）：
 * 东财行情主机 push2 / push2delay / push2his / 79.push2his 是**整组**在 TLS 握手阶段被连接重置
 * （约 100ms 内 ECONNRESET；换目标 IP、换 SNI、改走明文 http 的结果一样），面板因此整块没数据。
 * 腾讯这两条接口同一天实测 200 且 Content-Type 是 UTF-8，可以直接接。
 * 换 user-agent / 补浏览器请求头对这种故障零作用 —— 连接死在 ClientHello，HTTP 请求还没发出去就被 RST，
 * 那是 L7 的层；客户端唯一有效的手段就是换源，所以这里做的是「换源」而不是「伪装」。
 */

export const TENCENT_KLINE_API = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get";
export const TENCENT_TREND_API = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query";
/**
 * 腾讯的后备入口（2026-10-09 实测同路径可用）：只在主入口失败时回落，且照样走 out() 的节流 ——
 * 高频打这两个会返回 501，所以顺序固定成「主入口 → 这两个」，不做来回轮换。
 */
export const TENCENT_FALLBACK_HOSTS = ["web.ifzq.gtimg.cn", "ifzq.gtimg.cn"];

/** 腾讯这些列都是字符串（"9.100" / "456711.000"）：空串与 "-" 一律落 null，别让 NaN 流进比较 */
function qnum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 东财 secid（`市场.代码`）→ 腾讯代码（sh600000 / sz300750 / bj920185）。
 * 北交所的市场号是 0，但腾讯认 bj 前缀（实测 2026-10-09：sz920185 返回空数组、bj920185 有数据），
 * 所以 92/4/8 这一段必须排在「0 → 深」之前判掉，与 secidOf 的前缀规则保持一致。
 */
export function tencentCodeOf(secid) {
  const m = /^([01])\.(\d{6})$/.exec(String(secid ?? "").trim());
  if (!m) return null;
  if (/^(92|4|8)/.test(m[2])) return `bj${m[2]}`;
  return `${m[1] === "1" ? "sh" : "sz"}${m[2]}`;
}

export const TENCENT_MINUTE_API = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline";
/**
 * 腾讯 K 线能供的周期段（2026-10-10 实测）：
 *   日K  走 fqkline（`param=<代码>,day,,,<条数>,qfq`）—— **必须带 qfq**，不带只回 `{version}`
 *   分钟 K 走 mkline（`param=<代码>,m5|m15|m30|m60,,<条数>`）—— 这两个端点在同一个 host 前缀下，
 *     实测 m5/m15/m30/m60 各回 120 根、时间形如 "202610091500"、列序与日K同为「开、收、高、低、量」。
 *     （`fqkline` 上的 m1/m5/m15/m30/m60 实测返回 200 但没有任何数组，所以分钟 K 只能走 mkline。）
 * 周线也实测有真数据，但 KLINE_PERIODS 里不许加周K，所以没有可达路径。
 */
const TENCENT_PERIODS = { 101: "day", 60: "m60", 30: "m30", 15: "m15", 5: "m5" };
/** 出错文案里要说清是哪个周期（「只回了 1 根日线」这种话在分钟线上会误导） */
const TEN_PERIOD_LABEL = { day: "日", week: "周", m60: "60分钟", m30: "30分钟", m15: "15分钟", m5: "5分钟" };

function tencentPeriod(klt) {
  return TENCENT_PERIODS[klt] ?? null;
}

/**
 * 腾讯 K 线的时间戳两种形态：日K 是 "2026-10-09"，分钟 K 是 "202610091500"（本地时间 YYYYMMDDHHMM）。
 * 统一成 "YYYY-MM-DD" / "YYYY-MM-DD HH:MM"，图上的横轴标签与回归断言都按这个形状取。
 */
function tencentBarTime(v) {
  const s = String(v ?? "").trim();
  if (/^\d{12}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/**
 * 腾讯 K 线的列序（2026-10-09 实测，`data.<代码>.qfqday`；周线是 `qfqweek`）：
 *   [0] 日期 [1] 开 [2] 收 [3] 高 [4] 低 [5] 成交量(手)
 *   样例 ["2026-09-17","9.100","9.060","9.140","9.030","456711.000"]
 * 注意是「开、收、高、低」而不是「开、高、低、收」。它确实与东财 klines 的 f52 开 / f53 收 /
 * f54 高 / f55 低 同序，但**这张表刻意与东财那张分开写**：两个源各自的口径要能被各自的单测钉住，
 * 合并成一张「看起来差不多」的表，会在下一次某个源改口径时静默画出错价的图。
 * 另外除权日那一行末尾会多一个对象（分红信息 {nd, fh_sh, djr, …}），所以只认前 6 列。
 */
const TEN_KLINE_COL = { date: 0, open: 1, close: 2, high: 3, low: 4, volume: 5 };

/** 复权序列的 key 是 qfq<period>；北交所与指数没有复权序列，key 直接是 day/week（实测 2026-10-09） */
function tencentSeries(node, period) {
  for (const key of [`qfq${period}`, period]) {
    if (Array.isArray(node?.[key])) return node[key];
  }
  return null;
}

/**
 * 昨收取自 qt 段的下标 4。**不要**用同级的 `prec`：实测那天 prec="9.510" 而昨收是 9.70
 * （用同一条 qt 里的 -1.65% 与 9.54 反推：9.54 / (1 - 0.0165) = 9.70，与 10-08 的日K收盘一致），
 * `prec` 是另一个口径的值。
 */
function tencentPrevClose(json, code) {
  return qnum(json?.data?.[code]?.qt?.[code]?.[4]);
}

export function parseTencentKline(json, { code, period = "day", count = MAX_KLINE_BARS } = {}) {
  const rows = tencentSeries(json?.data?.[code], period);
  // 「data 里取不到该代码的数组」= 这个源这次不能用（代码拼错、接口改形状都落在这里）
  if (!rows) throw new Error(`响应里没有 ${code} 的${TEN_PERIOD_LABEL[period] ?? period}线数组`);
  const bars = rows
    .map((row) => {
      const p = Array.isArray(row) ? row : [];
      return {
        time: tencentBarTime(p[TEN_KLINE_COL.date]),
        open: qnum(p[TEN_KLINE_COL.open]),
        close: qnum(p[TEN_KLINE_COL.close]),
        high: qnum(p[TEN_KLINE_COL.high]),
        low: qnum(p[TEN_KLINE_COL.low]),
        volume: qnum(p[TEN_KLINE_COL.volume]),
        // 这条接口不给成交额与换手率（东财的 f57/f58），留 null 而不是拿别的列顶上
        amount: null,
        turnover: null,
      };
    })
    // 解不出日期或开收价的整根丢掉
    .filter((b) => b.time && Number.isFinite(b.open) && Number.isFinite(b.close));
  // **少于 2 根就当这个源不供该标的历史**：实测 2026-10-10 `param=bj920185,day,,,120,qfq` 只回 1 行
  // （= 当日那根，键名是 day 而不是 qfqday），1 根既画不出图（charts.js 要 ≥2）也不可能是历史 ——
  // 判失败，让链路下移或落到错误行，不许拿它充数画成一张「历史图」。
  // 阈值不取「远少于请求根数」：实测指数 sh000001（走 day 键）与 ETF sz159915（走 qfqday）都满 120 根，
  // 新上市标的的真历史也可能只有几根 —— 能确定是坏的就只有 0/1 根这一档。
  if (bars.length < 2) {
    throw new Error(`${code} 只回了 ${bars.length} 根${TEN_PERIOD_LABEL[period] ?? period}线（不供这个标的的历史）`);
  }
  // 腾讯会多回一根（实测 count=120 → 121 行），按请求条数从尾部对齐
  const want = Math.max(1, Math.round(count) || MAX_KLINE_BARS);
  return { bars: bars.slice(-want), preKPrice: tencentPrevClose(json, code) };
}

/**
 * 腾讯分时的列（2026-10-09 实测，`data.<代码>.data.data`，每项是空格分隔的字符串）：
 *   [0] 时刻 HHMM [1] 价格 [2] 当日累计成交量(手) [3] 当日累计成交额(元)
 *   首条 "0930 9.70 4256 4128320.00"、末条 "1530 9.54 948106 915450551.88"
 * 第 3、4 列是**累计**而不是当分钟增量：实测整条单调不减，且末条 948106 手 / 915450551.88 元与
 * 同花顺快照（947958 手 / 915309833 元，采于同日 15:22）对得上 —— 两个数不等是正常的，
 * 分时覆盖到 15:30 收盘，快照采得早。
 * 均价只能自己算：累计额 ÷ (累计量 × 100)；北交所的响应只有 3 列（没有成交额），均价就留空。
 * 东财 trends2 的最后一列给的**是**当日累计均价，与腾讯这里的第 4 列不是一回事，
 * 两个源的解析结果不许直接塞进同一个字段。
 */
const TEN_MINUTE_COL = { time: 0, price: 1, volume: 2, amount: 3 };

/** HHMM → HH:MM（分时轴的标签与单测都按 HH:MM 断言） */
function clockOfHhmm(v) {
  const s = String(v ?? "").trim();
  return /^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : "";
}

/**
 * 连续竞价时段 09:30–11:30 / 13:00–15:00。腾讯对部分标的还回 15:06–15:30 的盘后行，
 * 那段塞进分时轴（242 个固定槽位）会挤出画布右侧，而且它不是连续竞价的形状，所以按时刻挡掉。
 */
function inTradingSession(time) {
  const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return (mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900);
}

/** 列序映射单独一层：这一层只认列，不判业务（累计量/累计额就是这里的第 3、4 列） */
export function parseTencentMinuteRows(rows) {
  return rows
    .map((line) => {
      const p = String(line ?? "").trim().split(/\s+/);
      return {
        time: clockOfHhmm(p[TEN_MINUTE_COL.time]),
        price: qnum(p[TEN_MINUTE_COL.price]),
        cumVolume: qnum(p[TEN_MINUTE_COL.volume]), // 累计，单位手
        cumAmount: qnum(p[TEN_MINUTE_COL.amount]), // 累计，单位元（没有这一列就是 null）
      };
    })
    .filter((r) => r.time && Number.isFinite(r.price));
}

export function parseTencentTrend(json, { code } = {}) {
  const rows = json?.data?.[code]?.data?.data;
  if (!Array.isArray(rows)) throw new Error(`响应里没有 ${code} 的分时数组`);
  const parsed = parseTencentMinuteRows(rows);
  // 数组在、行也非空，却一行都解不出 —— 列序变了，判失败，别画（数组本身为空是盘前的正常形态，
  // 交给界面画「还没有分时数据」的提示，不算源故障）
  if (rows.length && !parsed.length) throw new Error(`${code} 的分时行一行都没解出来（列序可能变了）`);
  const kept = parsed.filter((r) => inTradingSession(r.time));
  const points = kept.map((r, i) => {
    const prev = kept[i - 1];
    return {
      time: r.time,
      price: r.price,
      // 图上的量能柱要的是「这一分钟的量」，腾讯只给累计量，这里做差分（首根就是开盘集合竞价的量）
      volume: Number.isFinite(r.cumVolume) ? r.cumVolume - (prev?.cumVolume ?? 0) : null,
      avg: Number.isFinite(r.cumAmount) && r.cumVolume > 0 ? r.cumAmount / (r.cumVolume * 100) : null,
      // 累计量/额留着：它是「这两列是累计」的判断依据，界面以后要用也不用再解析一遍
      cumVolume: r.cumVolume,
      cumAmount: r.cumAmount,
    };
  });
  return { points, preClose: tencentPrevClose(json, code) };
}

/* ================= 快照（实时行情 + 五档）：腾讯 / 新浪 ================= */

/**
 * 腾讯快照 `qt.gtimg.cn/q=<代码逗号连接>`，2026-10-10 实测：
 *   200、`Content-Type: text/html; charset=GBK`，每只一行 `v_<代码>="..."`，`~` 分隔。
 *   沪/深 **88 段**、北交所 **87 段**（少的那段在尾部，段位对齐到 48 段为止，实测北交所 47/48 段取值正常）。
 *   段位（0 基）：
 *     1 名称 2 代码 3 现价 4 昨收 5 今开 6 成交量(手)
 *     9..18 买一至买五（价、量(手) 交替）  19..28 卖一至卖五（价、量 交替）
 *     30 时间 "20261009161457"（本地时间 YYYYMMDDHHMMSS）33 最高 34 最低 51 均价(元)
 *     47 涨停价 48 跌停价（交易所给的价，与东财 f51/f52 语义等价）
 *   实测三例（涨跌停 = 昨收 × 1.1 / 1.2 / 1.3，按分四舍五入到两位）：
 *     沪主板 sh600000 昨收 9.70 → 10.67 / 8.73；创业板 sz300750 286.75 → 344.10 / 229.40；
 *     北交所 bj920185 21.01 → 27.31 / 14.71。所以**不按代码前缀猜幅度**，直接用 47/48。
 *   **没有成交时**（休市/停牌/退市僵尸代码，实测 sh600001）：3/4 段保留最后一笔价，5/6 段是 0，
 *     9..28 的价量全 0，30 段是当天 090000，**47/48 段给 -1** —— -1 必须落成 null，
 *     界面那两栏才知道「这个源这次不供」，不许当成价格参与比较。
 *   段 32（涨跌幅）不读：休市/停牌时各家口径不同，一律用 3 与 4 段自己算。
 *   批量实测：**一次 40 只**（URL 381 字符）→ 200；不存在的代码**整行不返回**（不是空值行），
 *     所以「请求 40 只只回来 36 行」是正常形态（那 4 只本来就没这个代码），不能当解析失败；
 *     自选上限是 20 只 + 指数，远在 40 以内，一次请求就能带走全部。
 *   请求必须带 qfq 那条说的是 K 线接口（不带只回 `{version}`），这条快照接口不涉及。
 */
export const TENCENT_QUOTE_API = "https://qt.gtimg.cn/q=";
const TEN_QUOTE_SEG = { name: 1, code: 2, price: 3, prevClose: 4, open: 5, volume: 6, time: 30, high: 33, low: 34, limitUp: 47, limitDown: 48, avg: 51 };
/** 五档：价在前、量在后，自买一（卖一）向外各五档 */
const TEN_BID_SEGS = [9, 11, 13, 15, 17];
const TEN_ASK_SEGS = [19, 21, 23, 25, 27];

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

/** 涨跌停价：≤0（腾讯用 -1 表示「不供」）一律落 null，别让 -1 参与「高于昨收」这类比较 */
function limitOf(v) {
  const n = qnum(v);
  return n !== null && n > 0 ? n : null;
}

/** 腾讯代码（sh600000 / sz300750 / bj920185）→ 东财 secid，与 tencentCodeOf 互逆 */
export function secidOfTencentCode(code) {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(String(code ?? "").trim().toLowerCase());
  if (!m) return null;
  // bj 与 sh/sz 的 0 号市场都归一：secidOf 那边 92/4/8 开头也是 0（北交所）
  return `${m[1] === "sh" ? 1 : 0}.${m[2]}`;
}

export function buildTencentQuoteUrl(codes) {
  return `${TENCENT_QUOTE_API}${codes.join(",")}`;
}

export function buildSinaQuoteUrl(codes) {
  return `${SINA_QUOTE_API}${codes.join(",")}`;
}

/**
 * 把一行行 `v_<代码>="…"` / `var hq_str_<代码>="…"` 拆成 [{ code, seg }]；解不出结构的行丢掉。
 * **前缀与分隔符都按源传进来，不许通用**：两家撞车的形状太像，混用会把「拿错了响应体」
 * 解析成一份看起来正常的空数据（实测踩过：把新浪的 body 喂给腾讯解析器，价格全是 null 却不算失败）。
 */
function splitQuoteLines(body, sep, prefix) {
  const out = [];
  const re = new RegExp(`^(?:var\\s+)?${prefix}([a-z]{2}\\d{6})="(.*)";?$`);
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes("=")) continue;
    const m = re.exec(line);
    if (!m) continue;
    out.push({ code: m[1], seg: m[2].split(sep) });
  }
  if (!out.length) throw new Error("响应里没有可解析的行情行");
  return out;
}

/**
 * 行情行的统一收口：一行都没解出来（含「解出来全是幽灵行」）就判这个源失败 ——
 * 否则 0 行会被当成「取数成功但这次没数据」，把上一次的价格留在界面上。
 */
function requireQuoteRows(rows) {
  if (!rows.length) throw new Error("响应里没有可解析的行情行");
  return rows;
}

/** 腾讯五档：价 > 0 才算这一档有效（无成交时整片是 0.00@0，界面要显示成「没有盘口数据」） */
function tencentLevels(seg, priceIdx) {
  const out = [];
  for (const i of priceIdx) {
    const price = limitOf(seg[i]);
    out.push({ price, volume: price === null ? null : qnum(seg[i + 1]) });
  }
  return out;
}

/**
 * 腾讯快照 → 内部行情结构（与东财 parseQuoteRow 同形）。
 * 涨跌幅与涨跌额自己算；时间戳按 `epochMsOfCompact` 归一成毫秒。
 */
export function parseTencentQuotes(body) {
  const rows = splitQuoteLines(body, "~", "v_")
    .map(({ code, seg }) => {
      const secid = secidOfTencentCode(code);
      if (!secid) return null;
      const price = qnum(seg[TEN_QUOTE_SEG.price]);
      const prevClose = qnum(seg[TEN_QUOTE_SEG.prevClose]);
      // 一行「行情行」要有名字或有价格才算数：新浪对不存在的代码回的是 `var hq_str_sz999999="";`，
      // 腾讯偶尔给空串行 —— 那种行留着就是个把真数据挤掉的幽灵条目（实测踩过：只装不存在代码的
      // 自选表被当成「取数成功、1 条」）。名字段为空且价格也解不出来的行直接判空丢掉
      const rawName = String(seg[TEN_QUOTE_SEG.name] ?? "").trim();
      if (!rawName && price === null) return null;
      return {
        secid,
        code,
        name: rawName || code,
        price,
        pct: pctOf(price, prevClose),
        change: changeOf(price, prevClose),
        volume: qnum(seg[TEN_QUOTE_SEG.volume]), // 手
        // 这条接口的成交额藏在复合段里，没实测出口径就不猜（界面也不显示它）
        amount: null,
        high: qnum(seg[TEN_QUOTE_SEG.high]),
        low: qnum(seg[TEN_QUOTE_SEG.low]),
        open: qnum(seg[TEN_QUOTE_SEG.open]),
        prevClose,
        // 涨跌停顺手带上（47/48 段，交易所给的价）：面板抬头的「涨停/跌停」在五档取不到时用它
        limitUp: limitOf(seg[TEN_QUOTE_SEG.limitUp]),
        limitDown: limitOf(seg[TEN_QUOTE_SEG.limitDown]),
        quoteAt: epochMsOfCompact(seg[TEN_QUOTE_SEG.time]),
      };
    })
    .filter(Boolean);
  return requireQuoteRows(rows);
}

/** 腾讯快照 → 内部盘口结构（与东财 parseDepthResponse 同形）。code 是要哪一只 */
export function parseTencentDepth(body, { code } = {}) {
  const hit = splitQuoteLines(body, "~", "v_").find((r) => r.code === code);
  if (!hit) throw new Error(`响应里没有 ${code} 这一行`);
  const seg = hit.seg;
  const price = qnum(seg[TEN_QUOTE_SEG.price]);
  const prevClose = qnum(seg[TEN_QUOTE_SEG.prevClose]);
  return {
    secid: secidOfTencentCode(code) ?? "",
    code,
    name: seg[TEN_QUOTE_SEG.name] || code,
    price,
    prevClose,
    open: qnum(seg[TEN_QUOTE_SEG.open]),
    high: qnum(seg[TEN_QUOTE_SEG.high]),
    low: qnum(seg[TEN_QUOTE_SEG.low]),
    volume: qnum(seg[TEN_QUOTE_SEG.volume]),
    amount: null,
    avgPrice: limitOf(seg[TEN_QUOTE_SEG.avg]),
    limitUp: limitOf(seg[TEN_QUOTE_SEG.limitUp]),
    limitDown: limitOf(seg[TEN_QUOTE_SEG.limitDown]),
    bids: tencentLevels(seg, TEN_BID_SEGS),
    asks: tencentLevels(seg, TEN_ASK_SEGS),
  };
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

/** 从常量 URL 里取主机名（后备入口只换 host，路径与查询串一模一样） */
function hostOf(url) {
  return new URL(url).hostname;
}

/** 请求头：UA 是我们自己的身份，不是伪装（见 AGENTS.md 的「故意不伪装成浏览器 UA」）；
 *  referer 是各家要的自家页面：东财要 quote.eastmoney.com、新浪要 finance.sina.com.cn（不带 403，实测），
 *  腾讯两条线都不需要（实测只带 UA 就 200）—— 三个源各用各的，别互相借。 */
const UA_HEADERS = [["user-agent", "DesktopPet/0.1 (personal desktop pet plugin)"]];
const EASTMONEY_HEADERS = [...UA_HEADERS, ["referer", "https://quote.eastmoney.com/"]];
const SINA_HEADERS = [...UA_HEADERS, ["referer", "https://finance.sina.com.cn"]];

/**
 * 源对象。`id` 是落盘与界面都在用的标识（改了等于把「上一次成功的源」这份记忆清空，别改）；
 * `klts` 是这个源能供的 K 线周期（不支持的周期直接跳过，不浪费一次请求）；
 * 每个 kind 给纯函数 `url(params)`、`parse(payload, params)` 与**自己的 `hosts`**（主入口在前，
 * 失败才走后备入口）—— 入口必须按 kind 分开：快照在 qt.gtimg.cn、K线/分时在 proxy.finance.qq.com，
 * 共用一份就等着把快照请求发到 K 线主机上去（这个错真踩过）。
 * 缺哪个 kind 就是不供（新浪没有 depth），取数链会跳过并说明；列序表一律各源各写。
 * `text: true` 表示这个 kind 的响应体是文本（腾讯/新浪的快照），不走 JSON 解码。
 */
export const MARKET_SOURCES = [
  {
    id: "eastmoney",
    label: "东方财富",
    klts: KLT_VALUES,
    headers: EASTMONEY_HEADERS,
    quote: {
      hosts: [hostOf(QUOTE_API)],
      url: ({ secids }) => buildQuoteUrl(secids),
      parse: (json) => parseQuoteResponse(json),
    },
    depth: {
      hosts: [hostOf(DETAIL_API)],
      url: ({ secid }) => buildDetailUrl(secid),
      parse: (json, { secid }) => parseDepthResponse(json, secid),
    },
    kline: {
      hosts: [hostOf(KLINE_API)],
      url: ({ secid, klt, count }) => buildKlineUrl(secid, klt, count),
      parse: (json) => parseKlineResponse(json),
    },
    trend: {
      hosts: [hostOf(TREND_API)],
      url: ({ secid }) => buildTrendUrl(secid),
      parse: (json) => parseTrendResponse(json),
    },
  },
  {
    id: "tencent",
    label: "腾讯",
    klts: KLT_VALUES,
    headers: UA_HEADERS,
    /** secid 转不出腾讯代码的标的就别试了（快照要代码，K线/分时也要） */
    ok: ({ code, codes }) => (codes ? codes.length > 0 : !!code),
    quote: {
      text: true,
      hosts: [hostOf(TENCENT_QUOTE_API)],
      url: ({ codes }) => buildTencentQuoteUrl(codes),
      parse: (body) => parseTencentQuotes(body),
    },
    // 快照与五档是同一条接口（qt.gtimg.cn 一行里就带五档），只是取不同的段
    depth: {
      text: true,
      hosts: [hostOf(TENCENT_QUOTE_API)],
      url: ({ code }) => buildTencentQuoteUrl([code]),
      parse: (body, { code }) => parseTencentDepth(body, { code }),
    },
    kline: {
      hosts: [hostOf(TENCENT_KLINE_API), ...TENCENT_FALLBACK_HOSTS],
      url: ({ code, klt, count }) =>
        tencentPeriod(klt) === "day"
          ? `${TENCENT_KLINE_API}?param=${code},day,,,${count},qfq`
          : `${TENCENT_MINUTE_API}?param=${code},${tencentPeriod(klt)},,${count}`,
      parse: (json, { code, klt, count }) => parseTencentKline(json, { code, period: tencentPeriod(klt), count }),
    },
    trend: {
      hosts: [hostOf(TENCENT_KLINE_API), ...TENCENT_FALLBACK_HOSTS],
      url: ({ code }) => `${TENCENT_TREND_API}?code=${code}`,
      parse: (json, { code }) => parseTencentTrend(json, { code }),
    },
  },
  {
    id: "sina",
    label: "新浪",
    headers: SINA_HEADERS,
    ok: ({ codes }) => codes.length > 0,
    // 只供价格快照，不供五档（盘口随时段被清空，见上面的实测记录）
    quote: {
      text: true,
      hosts: [hostOf(SINA_QUOTE_API)],
      url: ({ codes }) => buildSinaQuoteUrl(codes),
      parse: (body) => parseSinaQuotes(body),
    },
  },
];

export function sourceLabelOf(id) {
  return MARKET_SOURCES.find((s) => s.id === id)?.label ?? "";
}

/** 落盘记忆里只认这几个 id（撤销授权会清存储，读到脏值就当没记过） */
export const SOURCE_IDS = MARKET_SOURCES.map((s) => s.id);

/** 界面上用的名字（错误行与日志都要说清是哪一段数据出的问题） */
export const KIND_NAMES = { quote: "行情", depth: "五档", trend: "分时", kline: "K线" };

/* ================= 取数（要 http 能力，由调用方把 request 传进来） ================= */

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

/** 文本响应（腾讯/新浪快照是 `v_xx="…"` 这种行文本，不是 JSON）：只校验状态与截断 */
function decodeText(resp, what) {
  if (!resp || resp.status < 200 || resp.status >= 300) {
    throw new Error(`${what} 返回 ${resp?.status ?? "?"}`);
  }
  if (resp.truncated) throw new Error(`${what} 响应过大被截断`);
  if (typeof resp.body !== "string" || !resp.body.trim()) throw new Error(`${what} 响应是空的`);
  return resp.body;
}

/** 掐掉宿主代理原始错误里的 URL 与 rustls 文档链接：聚合错误要能塞进界面一行 */
export function briefReason(err) {
  const raw = String(err?.message ?? err);
  const head = raw.split(/:?\s*https?:\/\//)[0].trim();
  return head || raw;
}

function urlOnHost(url, host) {
  return url.replace(/^https:\/\/[^/]+/, `https://${host}`);
}

/** 一个源的尝试：主入口 → 后备入口。全失败抛出的 message 里带着源名与每个入口的原因 */
async function trySource(request, source, kind, params) {
  const spec = source[kind];
  const reasons = [];
  // 入口按 kind 走（见 MARKET_SOURCES 的注释）：快照在 qt.gtimg.cn，K线/分时在 proxy.finance.qq.com
  for (const host of spec.hosts) {
    const url = urlOnHost(spec.url(params), host);
    try {
      const resp = await request(url, { headers: source.headers });
      const payload = spec.text ? decodeText(resp, `${source.label}${KIND_NAMES[kind]}`) : decode(resp, `${source.label}${KIND_NAMES[kind]}`);
      const data = spec.parse(payload, params);
      return { data, source: source.id, host };
    } catch (err) {
      // 冷却/限流是全局的（出网只有一个闸门），换源与换入口都不会好，把话直接交回调用方
      if (err?.cooldown) throw err;
      reasons.push(`${host}: ${briefReason(err)}`);
    }
  }
  const err = new Error(`${source.label}（${reasons.join("；")}）`);
  err.detail = reasons;
  throw err;
}

/**
 * 取数主循环：先试「上一次成功的源」，再依次下移；一个源内部先试主入口，失败才试后备入口。
 * 全部失败抛出的 message 可以直接给界面（一行，含每个源与入口），`detail` 给调用方写日志（每个源一条）。
 */
async function fetchFromSources(kind, request, params, preferred) {
  const ordered = [
    ...MARKET_SOURCES.filter((s) => s.id === preferred),
    ...MARKET_SOURCES.filter((s) => s.id !== preferred),
  ];
  const detail = [];
  for (const source of ordered) {
    // 不供这个 kind 的源（新浪没有五档）直接跳过，并说清是「不供」而不是「失败」
    if (!source[kind]) {
      detail.push(`${source.label}：不供${KIND_NAMES[kind]}`);
      continue;
    }
    if (kind === "kline" && !source.klts.includes(params.klt)) {
      detail.push(`${source.label}：不支持该周期`);
      continue;
    }
    if (source.ok && !source.ok(params)) {
      detail.push(`${source.label}：这个代码转不过去`);
      continue;
    }
    try {
      return await trySource(request, source, kind, params);
    } catch (err) {
      if (err?.cooldown) throw err;
      detail.push(err.message);
    }
  }
  const err = new Error(`${KIND_NAMES[kind]}取数失败：${detail.join("；")}`);
  err.detail = detail;
  throw err;
}

/**
 * 自选列表快照：多源批量取数（腾讯/新浪一次带走全部自选，东财同样是一次 ulist）。
 * 返回 { data: [quote…], source, host }。
 */
export async function fetchQuotes(request, secids, { preferred = "" } = {}) {
  const list = [...new Set((secids ?? []).filter(Boolean))].slice(0, MAX_SECIDS);
  if (list.length === 0) return { data: [], source: "", host: "" };
  const codes = list.map(tencentCodeOf).filter(Boolean);
  return fetchFromSources("quote", request, { secids: list, codes }, preferred);
}

export async function fetchSuggest(request, keyword) {
  const resp = await request(buildSuggestUrl(keyword), { headers: EASTMONEY_HEADERS });
  return parseSuggestResponse(decode(resp, "搜索"));
}

/** 五档盘口：多源取数（腾讯的五档与快照是同一条接口的另一段；新浪不供五档） */
export async function fetchDepth(request, secid, { preferred = "" } = {}) {
  const params = { secid, code: tencentCodeOf(secid) };
  return fetchFromSources("depth", request, params, preferred);
}

/** K 线：多源取数，返回 { data, source, host }；`preferred` 是「上一次成功的源」 */
export async function fetchKline(request, secid, klt = 101, { preferred = "" } = {}) {
  const params = { secid, code: tencentCodeOf(secid), klt, count: MAX_KLINE_BARS };
  return fetchFromSources("kline", request, params, preferred);
}

/** 当日分时：多源取数，返回 { data, source, host } */
export async function fetchTrend(request, secid, { preferred = "" } = {}) {
  const params = { secid, code: tencentCodeOf(secid) };
  return fetchFromSources("trend", request, params, preferred);
}
