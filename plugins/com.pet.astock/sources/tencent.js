// 腾讯源：K线（日K走 fqkline、分钟K走 mkline）、分时与快照的 URL 构造、列序映射与解析。
// 原 market.js 的腾讯部分按源拆出，口径逐字未动；腾讯/新浪两家文本源共用的行解析助手也收在这里。

import { changeOf, epochMsOfCompact, MAX_KLINE_BARS, pctOf } from "../market.js";

export const TENCENT_KLINE_API = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get";
export const TENCENT_TREND_API = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query";
/**
 * 腾讯的后备入口（2026-10-09 实测同路径可用）：只在主入口失败时回落，且照样走 out() 的节流 ——
 * 高频打这两个会返回 501，所以顺序固定成「主入口 → 这两个」，不做来回轮换。
 */
export const TENCENT_FALLBACK_HOSTS = ["web.ifzq.gtimg.cn", "ifzq.gtimg.cn"];

/** 腾讯这些列都是字符串（"9.100" / "456711.000"）：空串与 "-" 一律落 null，别让 NaN 流进比较 */
export function qnum(v) {
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

export function tencentPeriod(klt) {
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

/** 涨跌停价：≤0（腾讯用 -1 表示「不供」）一律落 null，别让 -1 参与「高于昨收」这类比较 */
export function limitOf(v) {
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

/**
 * 把一行行 `v_<代码>="…"` / `var hq_str_<代码>="…"` 拆成 [{ code, seg }]；解不出结构的行丢掉。
 * **前缀与分隔符都按源传进来，不许通用**：两家撞车的形状太像，混用会把「拿错了响应体」
 * 解析成一份看起来正常的空数据（实测踩过：把新浪的 body 喂给腾讯解析器，价格全是 null 却不算失败）。
 */
export function splitQuoteLines(body, sep, prefix) {
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
export function requireQuoteRows(rows) {
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

/** 请求头：UA 是我们自己的身份，不是伪装（见 AGENTS.md 的「故意不伪装成浏览器 UA」）；
 *  referer 是各家要的自家页面：东财要 quote.eastmoney.com、新浪要 finance.sina.com.cn（不带 403，实测），
 *  腾讯两条线都不需要（实测只带 UA 就 200）—— 三个源各用各的，别互相借。 */
export const UA_HEADERS = [["user-agent", "DesktopPet/0.1 (personal desktop pet plugin)"]];
