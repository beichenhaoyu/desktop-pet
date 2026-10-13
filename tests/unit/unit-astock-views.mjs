// M4 拆分带出来的纯函数常驻单测：views/dom.js、core.js、panel.js、alerts.js 里无 DOM 依赖的那批。
//
// 运行：node --test tests/unit/unit-astock-views.mjs（与 cwd 无关）
// 说明：本轮不进 npm run unit 的清单（M4 卡片不许改 package.json，是否收编由 PM 统合时定）。
//
// 约束：离线、无 DOM、不启动任何窗口；只 import 磁盘上的插件源码（相对本文件的 file URL）。
// 不测面：mount* / watchView / addStyle / tag 这类要真实 DOM 的函数 —— 测它们就得造假 DOM，
// 那只会产出恒真断言；运行时由 verify:astock 的像素与挂载断言覆盖。

import { check, eq, group } from "./harness.mjs";

const src = (name) => new URL(`../../plugins/com.pet.astock/${name}`, import.meta.url).href;
const D = await import(src("views/dom.js"));
const C = await import(src("core.js"));
const P = await import(src("panel.js"));
const A = await import(src("alerts.js"));
const SU = await import(src("views/settings/util.js"));

/* ============================ views/dom.js ============================ */
group("views-dom 行情格式化");

eq("fmtPrice 保留两位小数", D.fmtPrice(3.1), "3.10");
eq("fmtPrice 零也带两位（0 是有效价格）", D.fmtPrice(0), "0.00");
eq("fmtPrice 负数", D.fmtPrice(-2.5), "-2.50");
eq("fmtPrice NaN 落成破折号，不显 NaN", D.fmtPrice(Number.NaN), "—");
eq("fmtPrice Infinity 落成破折号", D.fmtPrice(Number.POSITIVE_INFINITY), "—");
eq("fmtPrice 字符串不算价格", D.fmtPrice("5.1"), "—");
eq("fmtPrice null 落成破折号", D.fmtPrice(null), "—");

eq("fmtPct 正数带 + 号", D.fmtPct(3.1), "+3.10%");
eq("fmtPct 负数自带 - 号", D.fmtPct(-2), "-2.00%");
eq("fmtPct 平盘不带符号", D.fmtPct(0), "0.00%");
eq("fmtPct 缺值落成破折号", D.fmtPct(Number.NaN), "—");
eq("fmtPct undefined 落成破折号", D.fmtPct(undefined), "—");
eq("fmtPct 字符串不算涨跌幅", D.fmtPct("1.2"), "—");

eq("toneOf 涨=up", D.toneOf({ pct: 1 }), "up");
eq("toneOf 跌=down", D.toneOf({ pct: -1 }), "down");
eq("toneOf 平=flat", D.toneOf({ pct: 0 }), "flat");
eq("toneOf 缺字段=flat", D.toneOf({}), "flat");
eq("toneOf null=flat", D.toneOf(null), "flat");
eq("toneOf 非数字 pct=flat（停牌/未开盘不装涨跌）", D.toneOf({ pct: "1" }), "flat");
eq("toneOf NaN=flat", D.toneOf({ pct: Number.NaN }), "flat");

eq("clockOf 按本地时区给 HH:mm:ss", D.clockOf(new Date(2026, 0, 2, 9, 5, 7).getTime()), "09:05:07");
eq("clockOf 非数字给空串", D.clockOf(undefined), "");
eq("clockOf 字符串给空串", D.clockOf("1700000000000"), "");
eq("PHASE_TEXT 七个时段词", Object.keys(D.PHASE_TEXT).length, 7);
eq("PHASE_TEXT 上午盘中", D.PHASE_TEXT.morning, "上午盘中");
eq("PHASE_TEXT 周末休市", D.PHASE_TEXT.weekend, "周末休市");

/* ============================ core.js ============================ */
group("core 输入归整与规则文案");

eq("ruleText 三个阈值全给", C.ruleText({ upper: 12.5, lower: 11, pct: 5, limit: false }), "≥12.5 ≤11 |±|≥5%");
eq("ruleText 一个没给=未设提醒（limit 显式关掉）", C.ruleText({ upper: null, lower: null, pct: null, limit: false }), "未设提醒");
eq("ruleText 没关涨跌停就有「涨跌停」", C.ruleText({ upper: 10 }), "≥10 涨跌停");
eq("ruleText 只有涨跌停", C.ruleText({ limit: true }), "涨跌停");
eq("ruleText 负的 pct 原样（界面输入口径不动）", C.ruleText({ pct: -3, limit: false }), "|±|≥-3%");

eq("clampNum 去掉千分位与空白", C.clampNum("1, 234"), 1234);
eq("clampNum 保留四位小数", C.clampNum(" 12.34567 "), 12.3457);
eq("clampNum 四舍五入到四位", C.clampNum(1.618034), 1.618);
eq("clampNum 零不算有效值", C.clampNum(0), null);
eq("clampNum 负数不算有效值", C.clampNum(-5), null);
eq("clampNum 非数字串给 null", C.clampNum("abc"), null);
eq("clampNum 空串给 null", C.clampNum(""), null);
eq("clampNum 科学计数法原样吃数字", C.clampNum("1e3"), 1000);

/* ============================ panel.js ============================ */
group("panel 错误裁剪与 K 线新鲜度");

eq("briefError 长错误按 90 字符截断", P.briefError(new Error("x".repeat(200))).length, 90);
eq("briefError 掐掉 URL 只留人话", P.briefError(new Error("boom https://example.com/path?q=1")), "boom");
eq("briefError 吃字符串", P.briefError("短的"), "短的");

eq("isKlineStale 刚拉过=不旧", P.isKlineStale({ klineAt: Date.now() }), false);
eq("isKlineStale 超 TTL=旧", P.isKlineStale({ klineAt: Date.now() - P.KLINE_STALE_MS - 1000 }), true);
eq("isKlineStale 未到 TTL=不旧", P.isKlineStale({ klineAt: Date.now() - P.KLINE_STALE_MS + 5000 }), false);
eq("isKlineStale 没有时间戳=旧（宁重拉）", P.isKlineStale({}), true);
eq("isKlineStale null 状态=旧", P.isKlineStale(null), true);

/* ============================ alerts.js ============================ */
group("alerts 日期");

{
  const t = A.today();
  check("today() 形状为 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(t), `实得 ${t}`);
  const [y, m, d] = t.split("-").map(Number);
  const round = new Date(y, m - 1, d);
  check(
    "today() 是本地今天的日期（回代比对）",
    round.getFullYear() === y && round.getMonth() === m - 1 && round.getDate() === d,
    `回代 ${round.toISOString()}`,
  );
}

/* ==================== views/settings/util.js（M4b 拆分带出来的分节共用口径） ==================== */
// 这些函数是从 settings.js 的闭包里搬出来的纯计算，界面壳（views/settings.js，4096 字节上限）
// 与五个分节都靠它们对齐口径；断言钉的是「搬出来之后口径没走样」。
group("views-settings-util 涨跌幅与涨跌停取值");

eq("rawPctOf 整数比例精确（(20/10-1)*100 = 100）", SU.rawPctOf(20, 10), 100);
eq("rawPctOf 价格归零即 -100%", SU.rawPctOf(0, 10), -100);
check(
  "rawPctOf 留原始长尾，不做四舍五入（market.pctOf 才 round 到两位）",
  SU.rawPctOf(1, 3) < -66.66 && SU.rawPctOf(1, 3) !== -66.67,
  `实得 ${SU.rawPctOf(1, 3)}`,
);
eq("rawPctOf 缺昨收给 NaN（不猜幅度）", SU.rawPctOf(10, undefined), Number.NaN);
eq("rawPctOf 昨收为 0 给 NaN", SU.rawPctOf(10, 0), Number.NaN);
eq("rawPctOf 字符串不算价格", SU.rawPctOf("10", 10), Number.NaN);

eq("pickLimit 优先五档那一路（交易所给的价）", SU.pickLimit(1815, 1800), 1815);
eq("pickLimit 五档没给就回落快照那一路", SU.pickLimit(undefined, 1815), 1815);
eq("pickLimit 两路都没有给 null（界面写「该源不供」）", SU.pickLimit(undefined, null), null);
eq("pickLimit 0 是有效价、不算缺失", SU.pickLimit(0, 1815), 0);

group("views-settings-util 档位深浅与 K 线周期");

eq("barWidthPct 满档就是 100%", SU.barWidthPct(100), 100);
eq("barWidthPct 零成交档也保留下限 2%", SU.barWidthPct(0), 2);
eq("barWidthPct 低于下限抬到 2%", SU.barWidthPct(1), 2);
eq("barWidthPct 中间档原样", SU.barWidthPct(37), 37);

eq("kltOptionValue 转字符串（select 按串比较）", SU.kltOptionValue({ klt: 101, label: "日K" }), "101");
eq("kltDisplay K 线页显示周期下拉", SU.kltDisplay("kline"), "");
eq("kltDisplay 分时页藏起周期下拉", SU.kltDisplay("trend"), "none");

group("views-settings-util 配置回显");

eq("modeOf 缺配置落 badge（原默认值）", SU.modeOf({}), "badge");
eq("modeOf 显式 off 不被默认值顶掉", SU.modeOf({ mode: "off" }), "off");
eq("intervalOf 缺配置落 20 秒", SU.intervalOf({}), 20);
eq("intervalOf 0 是显式值，不落默认", SU.intervalOf({ intervalSec: 0 }), 0);
eq("prefChecked 只有显式 false 才算关", SU.prefChecked(undefined), true);
eq("prefChecked 显式 false = 关", SU.prefChecked(false), false);

group("views-settings-util 状态行与出网行");

eq(
  "statusText 完整一行",
  SU.statusText({ phaseLabel: "上午盘中", count: 3, net: { intervalSec: 30 }, cfgIntervalSec: 20, error: "" }).text,
  "上午盘中 · 盯 3 只 · 间隔 30s",
);
eq(
  "statusText 冷却与错误都进文案",
  SU.statusText({ phaseLabel: "已收盘", count: 1, net: { intervalSec: 60, cooldownLeftSec: 5 }, error: "行情超时" }).text,
  "已收盘 · 盯 1 只 · 间隔 60s · 限流冷却 5s · 行情超时",
);
eq(
  "statusText 协议没报间隔就用配置值",
  SU.statusText({ phaseLabel: "", count: 0, net: {}, cfgIntervalSec: 20, error: undefined }).text,
  " · 盯 0 只 · 间隔 20s",
);
eq(
  "statusText 两处都没有间隔给破折号",
  SU.statusText({ phaseLabel: "已收盘", count: 2, net: {}, error: "" }).text,
  "已收盘 · 盯 2 只 · 间隔 —s",
);
eq(
  "statusText 一切正常不按异常色",
  SU.statusText({ phaseLabel: "上午盘中", count: 1, net: {}, error: "" }).error,
  false,
);
eq(
  "statusText 限流冷却也算异常色（即便没错误）",
  SU.statusText({ phaseLabel: "上午盘中", count: 1, net: { cooldownLeftSec: 1 }, error: "" }).error,
  true,
);

eq(
  "netText 基本窗口一行",
  SU.netText({ window: 3, perMinute: 12, minGapMs: 500 }, (id) => id),
  "近 1 分钟出网 3 次（上限 12，两次之间至少 500ms）",
);
eq(
  "netText 退避与限流都写上",
  SU.netText({ window: 1, perMinute: 8, minGapMs: 900, intervalSec: 60, noProgress: 2, strikes: 1 }, (id) => id),
  "近 1 分钟出网 1 次（上限 8，两次之间至少 900ms） · 行情未更新，已退避到 60s · 已被限流 1 次",
);
eq(
  "netText 数据源按 labelOf 翻名，五档与行情同源就不重复报",
  SU.netText({ sources: { quote: "eastmoney", depth: "eastmoney", kline: "tencent" } }, (id) => `《${id}》`),
  "近 1 分钟出网 0 次（上限 —，两次之间至少 —ms） · 行情数据源 《eastmoney》 · K线数据源 《tencent》",
);
eq(
  "netText 空 net 也给一行、不抛",
  SU.netText(undefined, (id) => id),
  "近 1 分钟出网 0 次（上限 —，两次之间至少 —ms）",
);
