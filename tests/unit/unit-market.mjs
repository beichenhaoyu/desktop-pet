// T01 market.js 三源解析层常驻单测（东财 / 腾讯 / 新浪）。
//
// 运行：npm run unit:astock（或 node tests/unit/unit-market.mjs，与 cwd 无关）
//
// 全程离线、不碰 DOM；只 import 磁盘上的插件源码（相对本文件的 file URL）。
// fixture 一律按 market.js 注释里的实测口径构造（列序、段位、时间戳形态），不凭记忆猜。
// 不在范围：fetchQuotes / fetchDepth / fetchTrend / fetchKline / fetchSuggest（要真网络）。

import { check, deep, eq, group, throws } from "./harness.mjs";

const src = (name) => new URL(`../../plugins/com.pet.astock/${name}`, import.meta.url).href;
const m = await import(src("market.js"));

function qp(url) {
  return new URL(url).searchParams;
}

/* ==================== 编码与 secid ==================== */
group("编码与secid");

eq("normalizeCode 六位裸码", m.normalizeCode("600519"), "600519");
eq("normalizeCode 数字入参", m.normalizeCode(600519), "600519");
eq("normalizeCode sh 前缀", m.normalizeCode("sh600519"), "600519");
eq("normalizeCode SH 大写前缀", m.normalizeCode("SH600519"), "600519");
eq("normalizeCode 后缀 .SH", m.normalizeCode("600519.SH"), "600519");
eq("normalizeCode 后缀 .bj", m.normalizeCode("920185.bj"), "920185");
eq("normalizeCode 前后空格", m.normalizeCode("  600519  "), "600519");
eq("normalizeCode 已有 secid 形态", m.normalizeCode("1.600519"), "600519");
eq("normalizeCode 拒绝空串", m.normalizeCode(""), null);
eq("normalizeCode 拒绝 5 位", m.normalizeCode("60051"), null);
eq("normalizeCode 拒绝 7 位", m.normalizeCode("6005199"), null);
eq("normalizeCode 拒绝含空格", m.normalizeCode("600 519"), null);
eq("normalizeCode 拒绝字母", m.normalizeCode("abc"), null);
eq("normalizeCode 拒绝 null/undefined", [m.normalizeCode(null), m.normalizeCode(undefined)].map(String).join(","), "null,null");

eq("secidOf 沪主板 6 开头 → 1.", m.secidOf("600519"), "1.600519");
eq("secidOf 沪 B 股 900953 → 1.（92 之外照旧给沪）", m.secidOf("900953"), "1.900953");
eq("secidOf 北交所 920185 必须落 0.", m.secidOf("920185"), "0.920185");
eq("secidOf 沪 ETF 5 开头 → 1.", m.secidOf("510300"), "1.510300");
eq("secidOf 深主板 0 开头 → 0.", m.secidOf("000001"), "0.000001");
eq("secidOf 深债 1 开头 → 0.", m.secidOf("113050"), "0.113050");
eq("secidOf 深 2 开头 → 0.", m.secidOf("200011"), "0.200011");
eq("secidOf 创业板 3 开头 → 0.", m.secidOf("300750"), "0.300750");
eq("secidOf 北交所 4 开头 → 0.", m.secidOf("430047"), "0.430047");
eq("secidOf 北交所 8 开头 → 0.", m.secidOf("830799"), "0.830799");
eq("secidOf 认不出的首位返回 null", m.secidOf("700001"), null);
eq("secidOf 非代码返回 null", m.secidOf("abc"), null);

eq("limitPct 主板 10", m.limitPct("600519"), 10);
eq("limitPct 创业板 20", m.limitPct("300750"), 20);
eq("limitPct 科创板 20", m.limitPct("688111"), 20);
eq("limitPct 北交所 92 段 30", m.limitPct("920185"), 30);
eq("limitPct 北交所 4 开头 30", m.limitPct("430047"), 30);
eq("limitPct 北交所 8 开头 30", m.limitPct("830799"), 30);
eq("limitPct 沪 B 股（900xxx）仍是 10", m.limitPct("900953"), 10);
check(
  "limitPct 的北交所口径与 secidOf 一致（92/4/8 都由 secidOf 归市场 0）",
  ["920185", "430047", "830799"].every((c) => m.limitPct(c) === 30 && m.secidOf(c) === `0.${c}`),
);
eq("limitPct 认不出也回落 10", m.limitPct(""), 10);

eq("isNum 数值真", [m.isNum(1), m.isNum(0), m.isNum(-1.5)].join(","), "true,true,true");
eq("isNum NaN 假", m.isNum(NaN), false);
eq("isNum Infinity 假", m.isNum(Infinity), false);
eq("isNum 字符串假", m.isNum("1"), false);
eq("isNum null/undefined 假", [m.isNum(null), m.isNum(undefined)].join(","), "false,false");

eq("tencentCodeOf 沪", m.tencentCodeOf("1.600000"), "sh600000");
eq("tencentCodeOf 深", m.tencentCodeOf("0.300750"), "sz300750");
eq("tencentCodeOf 北交所 92 开头", m.tencentCodeOf("0.920185"), "bj920185");
eq("tencentCodeOf 北交所 4 开头", m.tencentCodeOf("0.430047"), "bj430047");
eq("tencentCodeOf 北交所 8 开头", m.tencentCodeOf("0.830799"), "bj830799");
eq("tencentCodeOf 指数（沪 0 开头）", m.tencentCodeOf("1.000001"), "sh000001");
eq("tencentCodeOf 非 secid 结构返回 null", m.tencentCodeOf("600000"), null);
eq("tencentCodeOf 市场号 2 返回 null", m.tencentCodeOf("2.600000"), null);

eq("secidOfTencentCode sh", m.secidOfTencentCode("sh600000"), "1.600000");
eq("secidOfTencentCode sz", m.secidOfTencentCode("sz300750"), "0.300750");
eq("secidOfTencentCode bj", m.secidOfTencentCode("bj920185"), "0.920185");
eq("secidOfTencentCode 大写前缀也认", m.secidOfTencentCode("SH600000"), "1.600000");
eq("secidOfTencentCode 拒绝未知前缀", m.secidOfTencentCode("xx600000"), null);
eq("secidOfTencentCode 拒绝 5 位", m.secidOfTencentCode("sh60000"), null);

{
  const secids = ["1.600000", "0.300750", "0.920185", "0.430047", "1.000001", "0.399006"];
  check("tencentCodeOf → secidOfTencentCode 互逆", secids.every((s) => m.secidOfTencentCode(m.tencentCodeOf(s)) === s));
  const codes = ["sh600000", "sz300750", "bj920185", "bj430047", "sz000001"];
  check("secidOfTencentCode → tencentCodeOf 互逆", codes.every((c) => m.tencentCodeOf(m.secidOfTencentCode(c)) === c));
}

/* ==================== URL 构造与源注册表 ==================== */
group("URL构造");

{
  const u = m.buildQuoteUrl(["1.600519", "0.000001", "1.600519", "", null]);
  eq("buildQuoteUrl 去重 + 滤空", qp(u).get("secids"), "1.600519,0.000001");
  eq("buildQuoteUrl fltt/invt", [qp(u).get("fltt"), qp(u).get("invt")].join(","), "2,2");
  eq("buildQuoteUrl fields 清单", qp(u).get("fields"), "f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124");
}
{
  const many = Array.from({ length: m.MAX_SECIDS + 5 }, (_, i) => `0.${100000 + i}`);
  const list = qp(m.buildQuoteUrl(many)).get("secids").split(",");
  eq("buildQuoteUrl 截断到 MAX_SECIDS 条", list.length, m.MAX_SECIDS);
  eq("buildQuoteUrl 截断保留前 MAX_SECIDS 条", list.at(-1), many[m.MAX_SECIDS - 1]);
  check("buildQuoteUrl 截断丢弃后面的", !list.includes(many[m.MAX_SECIDS]));
}
{
  const u = m.buildDetailUrl("1.600519");
  eq("buildDetailUrl secid", qp(u).get("secid"), "1.600519");
  check("buildDetailUrl 不得带 fields（实测接口怪癖：点名就丢字段）", !qp(u).has("fields") && !u.includes("fields="));
  eq("buildDetailUrl invt/fltt", [qp(u).get("invt"), qp(u).get("fltt")].join(","), "2,2");
}
{
  const u = m.buildKlineUrl("1.600519", 60, 60);
  eq("buildKlineUrl 合法周期透传", qp(u).get("klt"), "60");
  eq("buildKlineUrl 条数透传", qp(u).get("lmt"), "60");
  eq("buildKlineUrl 复权与结束日", [qp(u).get("fqt"), qp(u).get("end")].join(","), "1,20500101");
  eq("buildKlineUrl fields2 列序", qp(u).get("fields2"), "f51,f52,f53,f54,f55,f56,f57,f58");
}
eq("buildKlineUrl 非法周期 102 回落 101", qp(m.buildKlineUrl("1.600519", 102)).get("klt"), "101");
eq("buildKlineUrl 非法周期 0 回落 101", qp(m.buildKlineUrl("1.600519", 0)).get("klt"), "101");
eq("buildKlineUrl 非法周期字符串回落 101", qp(m.buildKlineUrl("1.600519", "abc")).get("klt"), "101");
eq("buildKlineUrl 条数下限夹到 10", qp(m.buildKlineUrl("1.600519", 101, 1)).get("lmt"), "10");
eq("buildKlineUrl 条数上限引用 MAX_KLINE_BARS", qp(m.buildKlineUrl("1.600519", 101, 9999)).get("lmt"), String(m.MAX_KLINE_BARS));
eq("buildKlineUrl 非法条数回落 MAX_KLINE_BARS", qp(m.buildKlineUrl("1.600519", 101, "abc")).get("lmt"), String(m.MAX_KLINE_BARS));
check("KLT_VALUES 不含 102/103（实测周/月K退化回日K，放进表里是错的）", !m.KLT_VALUES.includes(102) && !m.KLT_VALUES.includes(103));
deep("KLT_VALUES 与 KLINE_PERIODS 对齐", m.KLT_VALUES, m.KLINE_PERIODS.map((p) => p.klt));

{
  const u = m.buildTrendUrl("1.600519");
  eq("buildTrendUrl ndays=1", qp(u).get("ndays"), "1");
  eq("buildTrendUrl iscr=0", qp(u).get("iscr"), "0");
  eq("buildTrendUrl secid", qp(u).get("secid"), "1.600519");
}
{
  const u = m.buildSuggestUrl("贵州茅台");
  eq("buildSuggestUrl type=14", qp(u).get("type"), "14");
  eq("buildSuggestUrl count=10", qp(u).get("count"), "10");
}
eq("buildSuggestUrl 中文编解码往返", qp(m.buildSuggestUrl(" 贵州茅台 ")).get("input"), "贵州茅台");
eq("buildSuggestUrl 关键词截到 32 字符", qp(m.buildSuggestUrl("a".repeat(40))).get("input"), "a".repeat(32));
eq("buildTencentQuoteUrl 直拼 q=", m.buildTencentQuoteUrl(["sh600000", "sz000001"]), m.TENCENT_QUOTE_API + "sh600000,sz000001");
eq("buildSinaQuoteUrl 直拼 list=", m.buildSinaQuoteUrl(["sh600000"]), m.SINA_QUOTE_API + "sh600000");

deep("SOURCE_IDS 顺序稳定", m.SOURCE_IDS, ["eastmoney", "tencent", "sina"]);
check("新浪不供五档（没有 depth 段）", !m.MARKET_SOURCES.find((s) => s.id === "sina").depth);
check(
  "腾讯 K 线/分时带后备入口",
  m.MARKET_SOURCES.find((s) => s.id === "tencent").kline.hosts.length === 1 + m.TENCENT_FALLBACK_HOSTS.length,
);
deep("TENCENT_FALLBACK_HOSTS 顺序固定（主入口 → 两个后备）", m.TENCENT_FALLBACK_HOSTS, ["web.ifzq.gtimg.cn", "ifzq.gtimg.cn"]);
eq("sourceLabelOf 已知 id", m.sourceLabelOf("tencent"), "腾讯");
eq("sourceLabelOf 未知 id 返回空串", m.sourceLabelOf("nope"), "");
eq("briefReason 掐掉 URL 尾巴", m.briefReason(new Error("fetch failed on https://push2.eastmoney.com/api/qt?x=1 (docs)")), "fetch failed on");
eq("briefReason 无 URL 时原样返回", m.briefReason(new Error("连接被重置")), "连接被重置");

/* ==================== 东财解析 ==================== */
group("东财解析");

const emRow = { f12: "600519", f13: 1, f14: "贵州茅台", f2: 1700.5, f3: 1.2, f4: 20.1, f5: 123456, f6: 2100000000, f15: 1710, f16: 1690, f17: 1695, f18: 1680.4, f124: 1759973400 };

{
  const q = m.parseQuoteRow(emRow);
  eq("parseQuoteRow secid", q.secid, "1.600519");
  eq("parseQuoteRow 名称", q.name, "贵州茅台");
  eq("parseQuoteRow 现价/昨收", [q.price, q.prevClose].join(","), "1700.5,1680.4");
  eq("parseQuoteRow quoteAt 秒 → 毫秒", q.quoteAt, 1759973400 * 1000);
  eq("parseQuoteRow 快照不带涨跌停字段", [q.limitUp, q.limitDown].map(String).join(","), "null,null");
}
{
  const q = m.parseQuoteRow({ ...emRow, f2: "-", f3: "-", f15: "-", f124: "-" });
  check("parseQuoteRow f2:'-' 落 null（不是 0/NaN）", q.price === null && q.pct === null && q.high === null);
  check("parseQuoteRow f124:'-' 落 null", q.quoteAt === null);
}
eq("parseQuoteRow 缺 f13 返回 null", m.parseQuoteRow({ f12: "600519" }), null);
eq("parseQuoteRow 缺 f12 返回 null", m.parseQuoteRow({ f13: 1 }), null);
eq("parseQuoteRow 非对象返回 null", [m.parseQuoteRow(null), m.parseQuoteRow("x")].map(String).join(","), "null,null");
eq("parseQuoteRow 缺名称回落代码", m.parseQuoteRow({ f12: "000001", f13: 0 }).name, "000001");

{
  const arr = m.parseQuoteResponse({ data: { diff: [emRow, { f12: "000001", f13: 0, f2: 9.5, f18: 9.4, f124: 1759973400 }] } });
  eq("parseQuoteResponse diff 为数组可解", arr.length, 2);
  eq("parseQuoteResponse 数组形态 secid", arr[1].secid, "0.000001");
  const obj = m.parseQuoteResponse({ data: { diff: { a: emRow, b: { f12: "000001", f13: 0, f2: 9.5, f18: 9.4 } } } });
  eq("parseQuoteResponse diff 为对象也可解", obj.length, 2);
  eq("parseQuoteResponse 对象形态 secid 集合", obj.map((r) => r.secid).sort().join(","), "0.000001,1.600519");
  eq("parseQuoteResponse 坏行被丢弃", m.parseQuoteResponse({ data: { diff: [emRow, { f12: "600000" }, null] } }).length, 1);
  eq("parseQuoteResponse 无 data 返回空数组", m.parseQuoteResponse({}).length, 0);
}

{
  const rows = m.parseSuggestResponse({
    QuotationCodeTable: {
      Data: [
        { Code: "600519", Name: "贵州茅台", MktNum: "1", SecurityTypeName: "沪A" },
        { Code: "920185", Name: "贝特瑞", MktNum: "0", SecurityTypeName: "北交所" },
        { Code: "60051", Name: "五位码", MktNum: "1" },
        { Code: "sh000001", Name: "非六位", MktNum: "1" },
        null,
      ],
    },
  });
  eq("parseSuggestResponse 丢掉非 6 位代码", rows.length, 2);
  eq("parseSuggestResponse 优先信 MktNum", rows.map((r) => r.secid).join(","), "1.600519,0.920185");
  eq("parseSuggestResponse 名称与类型", [rows[0].name, rows[0].type].join("|"), "贵州茅台|沪A");
  const many = m.parseSuggestResponse({
    QuotationCodeTable: { Data: Array.from({ length: 15 }, (_, i) => ({ Code: String(600000 + i), Name: "n", MktNum: "1" })) },
  });
  eq("parseSuggestResponse 最多 12 条", many.length, 12);
  eq("parseSuggestResponse 无表返回空数组", m.parseSuggestResponse({}).length, 0);
}

const depthRow = {
  f57: "600519", f58: "贵州茅台", f43: 1700.5, f60: 1680.4, f46: 1695, f44: 1710, f45: 1690, f47: 123456, f48: 2100000000, f71: 1701.2,
  f19: 1700.4, f20: 100, f17: 1700.3, f18: 200, f15: 1700.2, f16: 300, f13: 1700.1, f14: 400, f11: 1700, f12: 500,
  f39: 1700.6, f40: 110, f37: 1700.7, f38: 210, f35: 1700.8, f36: 310, f33: 1700.9, f34: 410, f31: 1701, f32: 510,
  f51: 1848.4, f52: 1512.4,
};
{
  const d = m.parseDepthResponse({ data: depthRow }, "1.600519");
  eq("parseDepthResponse 买盘 f19→f11 五档", d.bids.map((r) => r.price).join(","), "1700.4,1700.3,1700.2,1700.1,1700");
  eq("parseDepthResponse 卖盘 f39→f31 五档", d.asks.map((r) => r.price).join(","), "1700.6,1700.7,1700.8,1700.9,1701");
  eq("parseDepthResponse 买一量 f20", d.bids[0].volume, 100);
  eq("parseDepthResponse 卖五量 f32", d.asks[4].volume, 510);
  eq("parseDepthResponse f51/f52 → limitUp/limitDown", [d.limitUp, d.limitDown].join(","), "1848.4,1512.4");
  eq("parseDepthResponse avgPrice f71", d.avgPrice, 1701.2);
  const half = m.parseDepthResponse({ data: { ...depthRow, f15: "-" } }, "1.600519");
  check("parseDepthResponse 无价的档连量一起为 null", half.bids[2].price === null && half.bids[2].volume === null);
  const zero = m.parseDepthResponse({ data: { ...depthRow, f51: 0, f52: -1 } }, "1.600519");
  eq("parseDepthResponse 涨跌停 ≤0 落 null", [zero.limitUp, zero.limitDown].map(String).join(","), "null,null");
}
throws("parseDepthResponse 缺 f57 抛错（判源失败，不许回空盘口）", () => m.parseDepthResponse({ data: {} }), "没解出来");
throws("parseDepthResponse f57 非字符串抛错", () => m.parseDepthResponse({ data: { f57: 600519 } }), "没解出来");
throws("parseDepthResponse 无 data 抛错", () => m.parseDepthResponse({}), "没解出来");

{
  const t = m.parseTrendResponse({
    data: {
      preClose: 9.7,
      trends: [
        "2026-10-09 09:30,9.70,9.71,9.72,9.69,400,3884000.00,9.706",
        "2026-10-09 09:31,9.71,9.70,9.72,9.69,300,2910000.00,9.704",
        "2026-10-09 09:32,-,-,-,-,-,-,-",
      ],
    },
  });
  eq("parseTrendResponse 坏行被丢弃", t.points.length, 2);
  eq("parseTrendResponse time 取时刻", t.points[0].time, "09:30");
  eq("parseTrendResponse 价取第 3 列（收）", t.points[0].price, 9.71);
  eq("parseTrendResponse preClose", t.preClose, 9.7);
  eq("防合并：分时末列 = 当日累计均价", t.points[0].avg, 9.706);
  eq("防合并：均价随行变化（不是换手率）", t.points[1].avg, 9.704);
}
{
  const k = m.parseKlineResponse({
    data: {
      preKPrice: 9.6,
      klines: [
        "2026-10-09,9.70,9.71,9.72,9.69,400,3884000.00,0.55",
        "badline",
        "2026-10-08,9.65,9.70,9.73,9.64,500,4840000.00,0.68",
      ],
    },
  });
  eq("parseKlineResponse 坏行被丢弃", k.bars.length, 2);
  eq("parseKlineResponse 开收高低列序", [k.bars[0].open, k.bars[0].close, k.bars[0].high, k.bars[0].low].join(","), "9.7,9.71,9.72,9.69");
  eq("防合并：K 线末列 = 换手率", k.bars[0].turnover, 0.55);
  eq("parseKlineResponse preKPrice", k.preKPrice, 9.6);
  eq("parseKlineResponse 无 klines 返回空 bars", m.parseKlineResponse({ data: {} }).bars.length, 0);
}

eq("pctOf 基本换算（自算，不信接口）", m.pctOf(9.54, 9.7), -1.65);
eq("pctOf 昨收 0 落 null", m.pctOf(9.54, 0), null);
eq("pctOf 缺值落 null", [m.pctOf(null, 9.7), m.pctOf(9.5, null)].map(String).join(","), "null,null");
eq("changeOf 基本换算", m.changeOf(9.54, 9.7), -0.16);
eq("changeOf 缺值落 null", m.changeOf(null, 9.7), null);

/* ==================== 腾讯解析 ==================== */
group("腾讯解析");

function tencentSegs(n) {
  return new Array(n).fill("");
}
function tencentLine(code, segs) {
  return `v_${code}="${segs.join("~")}";`;
}

const shSegs = tencentSegs(88);
shSegs[1] = "浦发银行"; shSegs[2] = "sh600000"; shSegs[3] = "9.54"; shSegs[4] = "9.70"; shSegs[5] = "9.68"; shSegs[6] = "948106";
shSegs[30] = "20261009161457"; shSegs[33] = "9.75"; shSegs[34] = "9.50"; shSegs[47] = "10.67"; shSegs[48] = "8.73"; shSegs[51] = "9.65";
const shBody = tencentLine("sh600000", shSegs);

{
  const q = m.parseTencentQuotes(shBody)[0];
  eq("腾讯快照 88 段：名称/现价/昨收", [q.name, q.price, q.prevClose].join("|"), "浦发银行|9.54|9.7");
  eq("腾讯快照 secid 换算", q.secid, "1.600000");
  eq("腾讯快照 pct 自算", q.pct, -1.65);
  eq("腾讯快照 change 自算", q.change, -0.16);
  eq("腾讯快照 高/低/开（33/34/5 段）", [q.high, q.low, q.open].join(","), "9.75,9.5,9.68");
  eq("腾讯快照 量取 6 段（手）", q.volume, 948106);
  eq("腾讯快照 涨跌停取 47/48 段", [q.limitUp, q.limitDown].join(","), "10.67,8.73");
  eq("腾讯快照 时间戳 30 段换算毫秒", q.quoteAt, new Date(2026, 9, 9, 16, 14, 57).getTime());
  eq("腾讯快照 不产成交额", q.amount, null);
}
{
  const bjSegs = tencentSegs(87);
  bjSegs[1] = "贝特瑞"; bjSegs[2] = "bj920185"; bjSegs[3] = "23.11"; bjSegs[4] = "21.01"; bjSegs[5] = "21.20"; bjSegs[6] = "125135";
  bjSegs[30] = "20261009150000"; bjSegs[33] = "23.50"; bjSegs[34] = "20.80"; bjSegs[47] = "27.31"; bjSegs[48] = "14.71";
  const q = m.parseTencentQuotes(tencentLine("bj920185", bjSegs))[0];
  eq("北交所 87 段：名称/现价/昨收", [q.name, q.price, q.prevClose].join("|"), "贝特瑞|23.11|21.01");
  eq("北交所 secid 落 0.", q.secid, "0.920185");
  eq("北交所 高/低", [q.high, q.low].join(","), "23.5,20.8");
  eq("北交所 涨跌停按 47/48 直接用（不按前缀猜幅度）", [q.limitUp, q.limitDown].join(","), "27.31,14.71");
  check("北交所 pct 仍自算为数字", Number.isFinite(q.pct));
}
{
  const dead = tencentSegs(88);
  dead[1] = "退市测试"; dead[2] = "sh600001"; dead[3] = "9.80"; dead[4] = "9.80"; dead[5] = "0"; dead[6] = "0";
  for (let i = 9; i <= 28; i++) dead[i] = "0";
  dead[30] = "20261009090000"; dead[47] = "-1"; dead[48] = "-1";
  const q = m.parseTencentQuotes(tencentLine("sh600001", dead))[0];
  eq("无成交形态：-1 落 null（不许参与比较）", [q.limitUp, q.limitDown].map(String).join(","), "null,null");
  eq("无成交形态：现价保留最后一笔", q.price, 9.8);
}
throws("腾讯快照：空 body 抛错（判源失败）", () => m.parseTencentQuotes(""), "可解析的行情行");
throws("腾讯快照：幽灵空串行不算一行", () => m.parseTencentQuotes('v_sz999999="";'), "可解析的行情行");
{
  const rows = m.parseTencentQuotes(`${tencentLine("sh600000", shSegs)}\nv_sz999999="";`);
  eq("幽灵行与真行混排只留真行", rows.length, 1);
}

const depthSegs = tencentSegs(88);
depthSegs[1] = "浦发银行"; depthSegs[2] = "sh600000"; depthSegs[3] = "9.54"; depthSegs[4] = "9.70"; depthSegs[5] = "9.68"; depthSegs[6] = "948106";
depthSegs[33] = "9.75"; depthSegs[34] = "9.50"; depthSegs[47] = "10.67"; depthSegs[48] = "8.73"; depthSegs[51] = "9.65";
depthSegs[9] = "9.53"; depthSegs[10] = "1200"; depthSegs[11] = "9.52"; depthSegs[12] = "800"; depthSegs[13] = "9.51"; depthSegs[14] = "600";
depthSegs[15] = "9.50"; depthSegs[16] = "400"; depthSegs[17] = "9.49"; depthSegs[18] = "200";
depthSegs[19] = "9.55"; depthSegs[20] = "1100"; depthSegs[21] = "9.56"; depthSegs[22] = "700"; depthSegs[23] = "9.57"; depthSegs[24] = "500";
depthSegs[25] = "9.58"; depthSegs[26] = "300"; depthSegs[27] = "9.59"; depthSegs[28] = "100";
const depthBody = tencentLine("sh600000", depthSegs);

{
  const d = m.parseTencentDepth(depthBody, { code: "sh600000" });
  eq("腾讯五档：买盘 9/11/13/15/17，价在前量在后", d.bids.map((r) => `${r.price}x${r.volume}`).join(","), "9.53x1200,9.52x800,9.51x600,9.5x400,9.49x200");
  eq("腾讯五档：卖盘 19/21/23/25/27", d.asks.map((r) => `${r.price}x${r.volume}`).join(","), "9.55x1100,9.56x700,9.57x500,9.58x300,9.59x100");
  eq("腾讯五档：均价段 51", d.avgPrice, 9.65);
  eq("腾讯五档：涨跌停", [d.limitUp, d.limitDown].join(","), "10.67,8.73");
}
{
  const neg = tencentSegs(88);
  neg[1] = "退市测试"; neg[2] = "sh600001"; neg[3] = "9.80"; neg[4] = "9.80"; neg[9] = "-1"; neg[10] = "1200"; neg[19] = "0"; neg[20] = "77"; neg[47] = "-1";
  const d = m.parseTencentDepth(tencentLine("sh600001", neg), { code: "sh600001" });
  check("腾讯五档：-1 的档价 null、量也 null", d.bids[0].price === null && d.bids[0].volume === null);
  check("腾讯五档：0 的档价 null", d.asks[0].price === null && d.asks[0].volume === null);
}
throws("腾讯五档：响应里没有目标代码抛错", () => m.parseTencentDepth(depthBody, { code: "sz300750" }), "没有 sz300750 这一行");

const dayRows = [
  ["2026-09-17", "9.100", "9.060", "9.140", "9.030", "456711.000"],
  ["2026-09-18", "9.060", "9.150", "9.180", "9.050", "512345.000", { nd: "2026-09-18", fh_sh: "0.5", djr: "x" }],
  ["2026-09-19", "9.150", "9.200", "9.210", "9.120", "333222.000"],
];
{
  const k = m.parseTencentKline({ data: { sh600000: { qfqday: dayRows, qt: { sh600000: ["", "", "", "", "9.70"] } } } }, { code: "sh600000", period: "day", count: 120 });
  eq("腾讯日K：开≠高，close 必须是第 3 列（开收高低）", [k.bars[0].open, k.bars[0].close, k.bars[0].high, k.bars[0].low].join(","), "9.1,9.06,9.14,9.03");
  eq("腾讯日K：除权行末尾多余对象被忽略", k.bars[1].volume, 512345);
  eq("腾讯日K：条数不超请求数", k.bars.length, 3);
  eq("腾讯日K：昨收取 qt 段 4", k.preKPrice, 9.7);
  eq("腾讯日K：不拿别的列顶成交额/换手率", [k.bars[0].amount, k.bars[0].turnover].map(String).join(","), "null,null");
}
{
  const k = m.parseTencentKline({ data: { sh600000: { qfqday: dayRows, qt: { sh600000: ["", "", "", "", "9.70"] } } } }, { code: "sh600000", period: "day", count: 2 });
  eq("腾讯日K：多回时按请求条数从尾部对齐", k.bars.length, 2);
  eq("腾讯日K：对齐保留的是最后两根", k.bars[0].time, "2026-09-18");
}
{
  const minute = {
    data: {
      sz300750: {
        qfqm5: [
          ["202610091500", "286.75", "286.80", "286.90", "286.70", "1234"],
          ["202610091505", "286.80", "286.85", "286.95", "286.75", "2345"],
        ],
        qt: { sz300750: ["", "", "", "", "285.30"] },
      },
    },
  };
  const k = m.parseTencentKline(minute, { code: "sz300750", period: "m5", count: 120 });
  eq("腾讯分钟K：12 位时间归一成 YYYY-MM-DD HH:MM", k.bars[0].time, "2026-10-09 15:00");
  eq("腾讯分钟K：同为开收高低", [k.bars[0].open, k.bars[0].close, k.bars[0].high, k.bars[0].low].join(","), "286.75,286.8,286.9,286.7");
}
{
  const onlyDay = { data: { bj920185: { day: dayRows.slice(0, 2), qt: { bj920185: ["", "", "", "", "21.01"] } } } };
  const k = m.parseTencentKline(onlyDay, { code: "bj920185", period: "day", count: 120 });
  eq("腾讯日K：无 qfq 前缀时回落 day 键（北交所形态）", k.bars.length, 2);
  eq("腾讯日K：day 键形态的昨收", k.preKPrice, 21.01);
}
throws(
  "腾讯日K：缺数组抛错（这个源这次不能用）",
  () => m.parseTencentKline({ data: { sh600000: { qt: {} } } }, { code: "sh600000", period: "day", count: 120 }),
  "没有 sh600000 的日线数组",
);
throws(
  "腾讯日K：只回 1 根判源不供（拿一根冒充历史是错的）",
  () => m.parseTencentKline({ data: { sh600000: { qfqday: [dayRows[0]] } } }, { code: "sh600000", period: "day", count: 120 }),
  "只回了 1 根",
);

{
  const rows = m.parseTencentMinuteRows(["0930 9.70 4256 4128320.00", "0931 9.71 5000 4863000.00", "zzzz 1 2 3", "0932 - - -"]);
  eq("腾讯分时行：坏行被丢弃", rows.length, 2);
  eq("腾讯分时行：HHMM → HH:MM", rows[0].time, "09:30");
  eq("腾讯分时行：价/累计量/累计额三列", [rows[0].price, rows[0].cumVolume, rows[0].cumAmount].join(","), "9.7,4256,4128320");
  const three = m.parseTencentMinuteRows(["0930 21.01 1251"]);
  eq("腾讯分时行：北交所 3 列没有累计额 → null", three[0].cumAmount, null);
}

const trendJson = {
  data: {
    sz300750: {
      data: {
        data: ["0930 286.75 100 2867500.00", "1130 287.00 500 14342500.00", "1300 287.00 700 20090000.00", "1501 286.90 900 25800000.00", "1530 286.80 1000 28680000.00"],
      },
      qt: { sz300750: ["", "", "", "", "285.30"] },
    },
  },
};
{
  const t = m.parseTencentTrend(trendJson, { code: "sz300750" });
  eq("腾讯分时：盘后 15:01/15:30 行被挡掉", t.points.map((p) => p.time).join(","), "09:30,11:30,13:00");
  eq("腾讯分时：量按累计量做差分（首根=竞价量）", t.points.map((p) => p.volume).join(","), "100,400,200");
  eq("腾讯分时：均价=累计额/(累计量×100)", [t.points[0].avg, t.points[2].avg].join(","), "286.75,287");
  eq("腾讯分时：昨收取 qt 段 4", t.preClose, 285.3);
  check("腾讯分时：累计量/额原样保留", t.points[2].cumVolume === 700 && t.points[2].cumAmount === 20090000);
}
{
  const t = m.parseTencentTrend({ data: { sz300750: { data: { data: [] } } } }, { code: "sz300750" });
  eq("腾讯分时：空数组是盘前正常形态（不抛）", t.points.length, 0);
}
{
  const bj = m.parseTencentTrend(
    { data: { bj920185: { data: { data: ["0930 21.01 1251", "1500 21.10 7000"] }, qt: { bj920185: ["", "", "", "", "21.01"] } } } },
    { code: "bj920185" },
  );
  eq("腾讯分时：北交所 3 列 → 均价留空", bj.points[0].avg, null);
  eq("腾讯分时：北交所首根量=累计量", bj.points[0].volume, 1251);
}
throws("腾讯分时：数组缺席抛错", () => m.parseTencentTrend({ data: {} }, { code: "sz300750" }), "没有 sz300750 的分时数组");
throws(
  "腾讯分时：行全解不出判列序变了",
  () => m.parseTencentTrend({ data: { sz300750: { data: { data: ["zzz 1 2 3"] } } } }, { code: "sz300750" }),
  "一行都没解出来",
);

/* ==================== 新浪解析 ==================== */
group("新浪解析");

const sinaSh = new Array(34).fill("");
sinaSh[0] = "浦发银行"; sinaSh[1] = "9.68"; sinaSh[2] = "9.70"; sinaSh[3] = "9.54"; sinaSh[4] = "9.75"; sinaSh[5] = "9.50";
sinaSh[8] = "94795849"; sinaSh[9] = "913450551.88"; sinaSh[30] = "2026-10-09"; sinaSh[31] = "15:34:59";
const sinaBj = new Array(39).fill("");
sinaBj[0] = "贝特瑞"; sinaBj[1] = "21.20"; sinaBj[2] = "21.01"; sinaBj[3] = "23.11"; sinaBj[4] = "23.50"; sinaBj[5] = "20.80";
sinaBj[8] = "12513513"; sinaBj[9] = "29200000.00"; sinaBj[30] = "2026-10-09"; sinaBj[31] = "15:00:00";
const sinaBody = `var hq_str_sh600000="${sinaSh.join(",")}";\nhq_str_bj920185="${sinaBj.join(",")}";`;

{
  const rows = m.parseSinaQuotes(sinaBody);
  eq("新浪：两行都解出（第二行无 var 前缀）", rows.length, 2);
  const sh = rows[0];
  eq("新浪：名称/开/昨收/现价/高/低", [sh.name, sh.open, sh.prevClose, sh.price, sh.high, sh.low].join(","), "浦发银行,9.68,9.7,9.54,9.75,9.5");
  eq("新浪：量股 → 手（94795849/100 四舍五入）", sh.volume, 947958);
  eq("新浪：成交额 9 段", sh.amount, 913450551.88);
  eq("新浪：该源没有涨跌停 → null", [sh.limitUp, sh.limitDown].map(String).join(","), "null,null");
  eq("新浪：时间戳按日期+时间换算毫秒", sh.quoteAt, new Date(2026, 9, 9, 15, 34, 59).getTime());
  eq("新浪：pct 自算", sh.pct, -1.65);
  eq("新浪：北交所量也换算成手（12513513 → 125135）", rows[1].volume, 125135);
}
{
  const mixed = m.parseSinaQuotes(`var hq_str_sh600000="${sinaSh.join(",")}";\nvar hq_str_sz999999="";`);
  eq("新浪：整行空串条目被丢弃", mixed.length, 1);
}
throws("新浪：整批都解不出来按源失败（抛错而不是空数组）", () => m.parseSinaQuotes('var hq_str_sz999999="";'), "可解析的行情行");
throws("新浪：空 body 抛错", () => m.parseSinaQuotes(""), "可解析的行情行");
throws("新浪解析器不吃腾讯 body（前缀不符判失败，不是静默空数据）", () => m.parseSinaQuotes(shBody), "可解析的行情行");
throws("腾讯解析器不吃新浪 body（同上，防拿错响应体）", () => m.parseTencentQuotes(sinaBody), "可解析的行情行");

/* ==================== 时间戳与时段 ==================== */
group("时间戳与时段");

eq("epochMsOfSeconds 秒 → 毫秒", m.epochMsOfSeconds(1759973400), 1759973400 * 1000);
eq("epochMsOfSeconds 毫秒入参原样保留", m.epochMsOfSeconds(1759973400000), 1759973400000);
eq("epochMsOfSeconds 1e11 边界视为毫秒", m.epochMsOfSeconds(1e11), 1e11);
eq("epochMsOfSeconds 0/负/null 落 null", [m.epochMsOfSeconds(0), m.epochMsOfSeconds(-5), m.epochMsOfSeconds(null)].map(String).join(","), "null,null,null");
eq("epochMsOfCompact 14 位解析", m.epochMsOfCompact("20261009161457"), new Date(2026, 9, 9, 16, 14, 57).getTime());
eq("epochMsOfCompact 位数不对落 null", [m.epochMsOfCompact("2026100916145"), m.epochMsOfCompact("202610091614570")].map(String).join(","), "null,null");
eq("epochMsOfCompact 非数字落 null", m.epochMsOfCompact("2026-10-09"), null);
eq("epochMsOfDateTime 日期+时间解析", m.epochMsOfDateTime("2026-10-09", "15:34:59"), new Date(2026, 9, 9, 15, 34, 59).getTime());
eq("epochMsOfDateTime 形态不对落 null", [m.epochMsOfDateTime("2026/10/09", "15:34:59"), m.epochMsOfDateTime("2026-10-09", "15:34")].map(String).join(","), "null,null");
{
  const t = new Date(2026, 9, 9, 15, 34, 59).getTime();
  const secs = Math.floor(t / 1000);
  check(
    "三源形态归一成同一毫秒值（切源可比的前提）",
    m.epochMsOfCompact("20261009153459") === t && m.epochMsOfDateTime("2026-10-09", "15:34:59") === t && m.epochMsOfSeconds(secs) === t,
  );
}

deep("progressOf 时间戳前进 → 判进展", m.progressOf({ prevAt: 1000, prevSource: "eastmoney", at: 2000, source: "eastmoney" }), { fresh: true, counted: true });
deep("progressOf 时间戳不动 → 不计进展但计入退避", m.progressOf({ prevAt: 2000, prevSource: "eastmoney", at: 2000, source: "eastmoney" }), { fresh: false, counted: true });
deep("progressOf 切源那一轮：不判进展、不计入退避", m.progressOf({ prevAt: 1000, prevSource: "eastmoney", at: 2000, source: "tencent" }), { fresh: false, counted: false });
deep("progressOf 切源且时间戳更旧也不判", m.progressOf({ prevAt: 9000, prevSource: "tencent", at: 2000, source: "sina" }), { fresh: false, counted: false });
deep("progressOf 这轮没拿到时间戳", m.progressOf({ prevAt: 1000, prevSource: "eastmoney", at: 0, source: "eastmoney" }), { fresh: false, counted: false });
deep("progressOf 首轮无记忆源按同源处理", m.progressOf({ prevAt: 0, prevSource: "", at: 5000, source: "tencent" }), { fresh: true, counted: true });

{
  const at = (mo, d, h, mi) => new Date(2026, mo - 1, d, h, mi, 0);
  const cases = [
    [at(10, 9, 9, 14), "pre", false],
    [at(10, 9, 9, 15), "auction", true],
    [at(10, 9, 9, 29), "auction", true],
    [at(10, 9, 9, 30), "morning", true],
    [at(10, 9, 11, 30), "morning", true],
    [at(10, 9, 11, 31), "lunch", false],
    [at(10, 9, 12, 59), "lunch", false],
    [at(10, 9, 13, 0), "afternoon", true],
    [at(10, 9, 15, 0), "afternoon", true],
    [at(10, 9, 15, 1), "closed", false],
  ];
  for (const [d, phase, trading] of cases) {
    const label = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    const s = m.marketSession(d);
    eq(`marketSession ${label} phase`, s.phase, phase);
    eq(`marketSession ${label} trading`, s.trading, trading);
  }
  eq("marketSession 周六不计交易", [m.marketSession(at(10, 10, 10, 0)).phase, m.marketSession(at(10, 10, 10, 0)).trading].join(","), "weekend,false");
  eq("marketSession 周日不计交易", m.marketSession(at(10, 11, 10, 0)).phase, "weekend");
}
