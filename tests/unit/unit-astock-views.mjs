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
