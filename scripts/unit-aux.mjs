// T02 判定层常驻单测：throttle.js / rules.js / charts.js 里的纯函数与判定逻辑。
//
// 运行：npm run unit:astock（或 node scripts/unit-aux.mjs，与 cwd 无关）
//
// 约束：离线、无 DOM、不启动任何窗口；只 import 磁盘上的插件源码（相对本文件的 file URL）。
// 冷却阶梯 / 退避上限这类结论一律引用被导入模块的导出常量（COOLDOWN_STEPS_MS / IDLE_MAX_SEC /
// JITTER_RATIO），不把具体毫秒数抄进断言。
//
// 不在本卡范围：charts.js 的 drawTrend / drawKline / prepareCanvas —— 它们要真实画布上下文，
// 由 verify:astock 用像素计数覆盖；本卡不造假画布（那只会产出恒真断言）。

const src = (name) => new URL(`../plugins/com.pet.astock/${name}`, import.meta.url).href;
const T = await import(src("throttle.js"));
const R = await import(src("rules.js"));
const C = await import(src("charts.js"));
const M = await import(src("market.js"));

let pass = 0;
let fail = 0;
const attempts = { throttle: 0, rules: 0, charts: 0, sourceBranch: 0 };
let group = "throttle";

function check(name, cond, detail = "") {
  attempts[group]++;
  if (cond) {
    pass++;
    return;
  }
  fail++;
  console.log(`FAIL [${group}] ${name}${detail ? " :: " + detail : ""}`);
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function deep(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

/* ============================ throttle ============================ */
group = "throttle";

// createGate：注入假时钟，验证「最小间隔」语义
{
  let t = 0;
  const gate = T.createGate({ now: () => t, minGapMs: 20 });
  eq("gate 首次 waitMs() 为 0（可立刻发）", gate.waitMs(), 0);
  eq("take() 返回当前时刻", gate.take(), 0);
  eq("take() 后立刻再问 = 完整最小间隔", gate.waitMs(), 20);
  t = 5;
  eq("过 5ms 后剩余 15ms", gate.waitMs(), 15);
  t = 19;
  eq("差 1ms 时剩余 1ms", gate.waitMs(), 1);
  t = 20;
  eq("到达最小间隔后放行", gate.waitMs(), 0);
  gate.take();
  t = 30;
  eq("第二次 take 后重新计时", gate.waitMs(), 10);
}

// createGate：滚动 60 秒窗口（窗口长度在实现里是字面量 60_000，无导出常量）
{
  let t = 0;
  const gate = T.createGate({ now: () => t, minGapMs: 20, perMinute: 3 });
  gate.take();
  t = 100;
  gate.take();
  t = 200;
  gate.take();
  eq("打满 perMinute 后，要等最老一条过期（60s 窗口）", gate.waitMs(), 60_000 - 200);
  t = 20_000;
  eq("窗口内等待时间随最老记录推进", gate.waitMs(), 60_000 - 20_000);
  t = 59_999;
  eq("距最老记录过期 1ms 时仍等 1ms", gate.waitMs(), 1);
  t = 60_000;
  eq("最老记录过期即放行", gate.waitMs(), 0);
  eq("stats().window 同步过期（3 → 2）", gate.stats().window, 2);
  eq("stats() 回显 perMinute", gate.stats().perMinute, 3);
  eq("stats() 回显 minGapMs", gate.stats().minGapMs, 20);
}

// createGate：跨过 60 秒窗口后旧记录自然过期
{
  let t = 0;
  const gate = T.createGate({ now: () => t });
  gate.take();
  t = 59_999;
  eq("未过 60 秒：记录还在窗口里", gate.stats().window, 1);
  t = 60_000;
  eq("跨过 60 秒：旧记录过期", gate.stats().window, 0);
}

// createGate：默认参数取自导出常量
{
  const s = T.createGate({}).stats();
  eq("默认 perMinute 引用 MAX_CALLS_PER_MIN", s.perMinute, T.MAX_CALLS_PER_MIN);
  eq("默认 minGapMs 引用 MIN_GAP_MS", s.minGapMs, T.MIN_GAP_MS);
}

// acquire：真实计时（minGapMs=120：三次串行至少要等 2 个间隔）
{
  await T.sleep(0);
  check("sleep(0) 可 await 且不抛错", true);
  const gate = T.createGate({ minGapMs: 120 });
  const t0 = Date.now();
  const first = await gate.acquire();
  await gate.acquire();
  await gate.acquire();
  const elapsed = Date.now() - t0;
  check("三次 acquire 总耗时 >= 240ms（真的在等）", elapsed >= 240, `elapsed=${elapsed}ms`);
  check("三次 acquire 没有离谱地超额等待（< 3000ms）", elapsed < 3000, `elapsed=${elapsed}ms`);
  check("acquire() 返回出网时刻（数字）", typeof first === "number");
}

// isThrottleError：明确「被拒」的信号为真，其余为假
eq("isThrottleError({status:429})", T.isThrottleError({ status: 429 }), true);
eq("isThrottleError({status:403})", T.isThrottleError({ status: 403 }), true);
eq("isThrottleError(new Error('too many requests'))", T.isThrottleError(new Error("too many requests")), true);
eq("isThrottleError({code:429})", T.isThrottleError({ code: 429 }), true);
eq("isThrottleError(new Error('请求频繁'))", T.isThrottleError(new Error("请求频繁")), true);
eq("isThrottleError(new Error('rate limit exceeded'))", T.isThrottleError(new Error("rate limit exceeded")), true);
eq("isThrottleError({status:200}) = false", T.isThrottleError({ status: 200 }), false);
eq("isThrottleError(new Error('行情 返回 404')) = false", T.isThrottleError(new Error("行情 返回 404")), false);

// isTransportError：传输层失败为真；带 4xx/5xx 状态的一律归 isThrottleError
eq("isTransportError(new Error('fetch failed'))", T.isTransportError(new Error("fetch failed")), true);
eq("isTransportError(peer closed connection …)", T.isTransportError(new Error("peer closed connection without sending TLS close_notify")), true);
eq("isTransportError(new Error('请求超时'))", T.isTransportError(new Error("请求超时")), true);
eq("isTransportError({status:200, message:'connection reset'}) 仍为 true", T.isTransportError({ status: 200, message: "connection reset" }), true);
eq("isTransportError({status:429, message:'fetch failed'}) = false（带状态码不算传输层）", T.isTransportError({ status: 429, message: "fetch failed" }), false);

// 两类判定必须分得开：「被拒要退开、连接被掐可重试」的前提
{
  const mixed = { status: 429, message: "fetch failed" };
  eq("同一对象：isThrottleError = true（被拒要退开）", T.isThrottleError(mixed), true);
  eq("同一对象：isTransportError = false（被拒不能当可重试）", T.isTransportError(mixed), false);
}

// cooldownMs：阶梯与封顶，全部引用导出常量
{
  const S = T.COOLDOWN_STEPS_MS;
  eq("冷却第 1 次 = 第一档", T.cooldownMs(1), S[0]);
  eq("冷却第 2 次 = 第二档", T.cooldownMs(2), S[1]);
  eq("冷却第 3 次 = 第三档", T.cooldownMs(3), S[2]);
  eq("冷却第 4 次 = 最后一档", T.cooldownMs(4), S[S.length - 1]);
  eq("冷却第 5 次封顶", T.cooldownMs(5), S[S.length - 1]);
  eq("冷却第 99 次仍封顶", T.cooldownMs(99), S[S.length - 1]);
  eq("第 0 次按第一档算", T.cooldownMs(0), S[0]);
  eq("负数按第一档算", T.cooldownMs(-3), S[0]);
  eq("NaN 按第一档算", T.cooldownMs(NaN), S[0]);
  let monotone = true;
  for (let i = 1; i <= 40; i++) if (T.cooldownMs(i) < T.cooldownMs(i - 1)) monotone = false;
  check("冷却阶梯单调不减（0..40 次）", monotone);
}

// nextIntervalSec：退避按 2 的幂、封顶 IDLE_MAX_SEC、不低于盘中值
{
  eq("noProgress=0 回到盘中值", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 0 }), 20);
  eq("noProgress 缺省也回到盘中值", T.nextIntervalSec({ tradingSec: 20, idleSec: 30 }), 20);
  eq("tradingSec=0 时不低于 1 秒", T.nextIntervalSec({ tradingSec: 0, idleSec: 30, noProgress: 0 }), 1);
  eq("noProgress=1 取 idle 值（高于盘中）", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 1 }), 30);
  eq("noProgress=2 按 2 的幂翻倍", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 2 }), 60);
  eq("noProgress=3 翻 4 倍", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 3 }), 120);
  eq("noProgress=4 翻 8 倍", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 4 }), 240);
  eq("noProgress=8 封顶 IDLE_MAX_SEC", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 8 }), T.IDLE_MAX_SEC);
  eq("noProgress=99 仍封顶 IDLE_MAX_SEC", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 99 }), T.IDLE_MAX_SEC);
  eq("idleSec 低于 tradingSec 时不低于盘中值", T.nextIntervalSec({ tradingSec: 60, idleSec: 5, noProgress: 3 }), 60);
  check("任意大 noProgress 都不超过 IDLE_MAX_SEC", T.nextIntervalSec({ tradingSec: 20, idleSec: 30, noProgress: 10_000 }) <= T.IDLE_MAX_SEC);
}

// jittered：边界与随机抽样
{
  eq("jittered：rnd=0.5 等于原值", T.jittered(100, () => 0.5), 100);
  eq("jittered：rnd=0 落在下边界", T.jittered(100, () => 0), Math.round(100 * (1 - T.JITTER_RATIO)));
  eq("jittered：rnd=1 落在上边界", T.jittered(100, () => 1), Math.round(100 * (1 + T.JITTER_RATIO)));
  const lo = Math.floor(100 * (1 - T.JITTER_RATIO));
  const hi = Math.ceil(100 * (1 + T.JITTER_RATIO));
  let inRange = true;
  let atLeastOne = true;
  for (let i = 0; i < 200; i++) {
    const v = T.jittered(100);
    if (v < lo || v > hi) inRange = false;
    if (v < 1) atLeastOne = false;
  }
  check("随机抽样 200 次都落在 ±JITTER_RATIO 区间内", inRange, `区间 [${lo}, ${hi}]`);
  check("随机抽样 200 次都不小于 1 秒", atLeastOne);
  eq("小数秒被抬到 1 秒下界", T.jittered(0.4, () => 0), 1);
}

/* ============================ rules ============================ */
group = "rules";

deep("KINDS 词表 = 五类提醒", R.KINDS, ["upper", "lower", "pct", "limitUp", "limitDown"]);
eq("limitPct 主板 = 10", M.limitPct("600519"), 10);
eq("limitPct 创业板 = 20", M.limitPct("300750"), 20);

const TODAY = "2026-10-12";

// upper：命中、边界（price === 阈值）
{
  const watch = [{ secid: "1.600519", code: "600519", name: "A", upper: 1700 }];
  const quotes = { "1.600519": { name: "贵州茅台", price: 1700.5, pct: 1.2, high: 1705, low: 1690 } };
  const hits = R.evalAlerts({ quotes, watch, alerted: {}, today: TODAY });
  eq("upper：命中条数 = 1", hits.length, 1);
  eq("upper：kind", hits[0]?.kind, "upper");
  eq("upper：level = up", hits[0]?.level, "up");
  eq("upper：key = today:code:kind", hits[0]?.key, `${TODAY}:600519:upper`);
  eq("upper：secid/code 原样带出", `${hits[0]?.secid}|${hits[0]?.code}`, "1.600519|600519");
  check(
    "upper：message 含行情里的名字与「涨到」",
    String(hits[0]?.message).includes("贵州茅台") && String(hits[0]?.message).includes("涨到"),
  );

  const edge = R.evalAlerts({
    quotes: { "1.600519": { name: "贵州茅台", price: 1700, pct: 1.2, high: 1705, low: 1690 } },
    watch,
    alerted: {},
    today: TODAY,
  });
  eq("upper：price === 阈值也算命中（>=）", edge.length, 1);
}

// lower：命中、边界（price === 阈值）
{
  const watch = [{ secid: "0.000001", code: "000001", name: "B", lower: 10 }];
  const quotes = { "0.000001": { name: "平安银行", price: 9.98, pct: -2.1, high: 10.2, low: 9.9 } };
  const hits = R.evalAlerts({ quotes, watch, alerted: {}, today: TODAY });
  eq("lower：命中条数 = 1", hits.length, 1);
  eq("lower：kind", hits[0]?.kind, "lower");
  eq("lower：level = down", hits[0]?.level, "down");
  eq("lower：key 形如 today:code:lower", hits[0]?.key, `${TODAY}:000001:lower`);

  const edge = R.evalAlerts({
    quotes: { "0.000001": { name: "平安银行", price: 10, pct: -2.1, high: 10.2, low: 9.9 } },
    watch,
    alerted: {},
    today: TODAY,
  });
  eq("lower：price === 阈值也算命中（<=）", edge.length, 1);
}

// pct：正负都算绝对值，边界与差一点
{
  const watch = [{ secid: "0.300750", code: "300750", name: "C", pct: 5 }];
  const quotes = { "0.300750": { name: "宁德时代", price: 200, pct: -6.2, high: 205, low: 198 } };
  const hits = R.evalAlerts({ quotes, watch, alerted: {}, today: TODAY });
  eq("pct：负幅超阈值命中", hits.length, 1);
  eq("pct：kind", hits[0]?.kind, "pct");
  eq("pct：负幅 → level = down", hits[0]?.level, "down");
  check("pct：message 含「跌」", String(hits[0]?.message).includes("跌"));

  const pos = R.evalAlerts({
    quotes: { "0.300750": { name: "宁德时代", price: 200, pct: 5, high: 205, low: 198 } },
    watch,
    alerted: {},
    today: TODAY,
  });
  eq("pct：正幅等于阈值也命中（|pct| >= 阈值）", pos.length, 1);
  eq("pct：正幅 → level = up", pos[0]?.level, "up");

  const just = R.evalAlerts({
    quotes: { "0.300750": { name: "宁德时代", price: 200, pct: 4.999, high: 205, low: 198 } },
    watch,
    alerted: {},
    today: TODAY,
  });
  eq("pct：差一点不命中", just.length, 0);
}

// limitUp：封板三条件（幅度到限 + 顶在最高价 + 有 pct）
{
  const watch = [{ secid: "1.600519", code: "600519", name: "D", limit: true }];
  const quotes = { "1.600519": { name: "贵州茅台", price: 11, pct: 10, high: 11, low: 10.4 } };
  const hits = R.evalAlerts({ quotes, watch, alerted: {}, today: TODAY });
  eq("limitUp：涨停命中", hits.length, 1);
  eq("limitUp：kind", hits[0]?.kind, "limitUp");

  const near = R.evalAlerts({
    quotes: { "1.600519": { name: "贵州茅台", price: 11, pct: 9.9, high: 11, low: 10.4 } },
    watch,
    alerted: {},
    today: TODAY,
  });
  eq("limitUp：幅度差一点不算封板", near.length, 0);

  const unsealed = R.evalAlerts({
    quotes: { "1.600519": { name: "贵州茅台", price: 10.9, pct: 10, high: 11, low: 10.4 } },
    watch,
    alerted: {},
    today: TODAY,
  });
  eq("limitUp：涨幅到限但没顶在最高价不算封板", unsealed.length, 0);
}

// limitDown
{
  const watch = [{ secid: "0.002594", code: "002594", name: "E", limit: true }];
  const quotes = { "0.002594": { name: "比亚迪", price: 24, pct: -10, high: 25, low: 24 } };
  const hits = R.evalAlerts({ quotes, watch, alerted: {}, today: TODAY });
  eq("limitDown：跌停命中", hits.length, 1);
  eq("limitDown：kind", hits[0]?.kind, "limitDown");
}

// 封板判定的价格优先口径（A10）：腾讯 47/48 段、东财 f51/f52 给的是**交易所价**，
// 有价就按价判（不再依赖 pct 与"顶在当日最高/最低"）；该源不供价（东财批量快照、新浪、
// 或 -1/0 这种不供标记）才回落按代码前缀猜的幅度。fixture 照 market.js 的 quote 形状构造。
{
  const bjWatch = [{ secid: "0.920185", code: "920185", name: "F", limit: true }];

  // 1) 北交所 +10% 且顶在当日最高，但没到交易所涨停价 27.31 → 旧实现（按前缀 10%）会误报
  const bjFalse = R.evalAlerts({
    quotes: {
      "0.920185": { name: "贝特瑞", price: 23.5, pct: 10, high: 23.5, low: 22.9, prevClose: 21.36, limitUp: 27.31, limitDown: 14.71 },
    },
    watch: bjWatch,
    alerted: {},
    today: TODAY,
  });
  eq("北交所 +10% 顶最高价但未到涨停价：不报（旧实现按 10% 误报）", bjFalse.length, 0);

  // 2) 价到涨停 → 报（价判优先）
  const bjHit = R.evalAlerts({
    quotes: {
      "0.920185": { name: "贝特瑞", price: 27.31, pct: 30, high: 27.31, low: 22.9, prevClose: 21.01, limitUp: 27.31, limitDown: 14.71 },
    },
    watch: bjWatch,
    alerted: {},
    today: TODAY,
  });
  eq("北交所价到涨停价：报 limitUp", bjHit[0]?.kind, "limitUp");

  // 3) 有交易所价时不再依赖 pct：pct 算不出来（null，昨收异常）照样能判
  const noPct = R.evalAlerts({
    quotes: {
      "1.600519": { name: "贵州茅台", price: 11, pct: null, high: 11, low: 10.4, prevClose: null, limitUp: 11, limitDown: 9 },
    },
    watch: [{ secid: "1.600519", code: "600519", name: "G", limit: true }],
    alerted: {},
    today: TODAY,
  });
  eq("有交易所价时 pct 为 null 仍报 limitUp", noPct[0]?.kind, "limitUp");

  // 4) 该源不供价（东财批量快照 limitUp/limitDown = null）→ 回落按前缀猜，行为与改动前一致
  const fallback = R.evalAlerts({
    quotes: {
      "1.600519": { name: "贵州茅台", price: 11, pct: 10, high: 11, low: 10.4, prevClose: 10, limitUp: null, limitDown: null },
    },
    watch: [{ secid: "1.600519", code: "600519", name: "G", limit: true }],
    alerted: {},
    today: TODAY,
  });
  eq("无价回落：主板 +10% 顶最高价仍按旧口径报 limitUp", fallback[0]?.kind, "limitUp");

  // 5) 跌停方向对称：价到跌停价、pct 缺失也报
  const down = R.evalAlerts({
    quotes: {
      "1.600519": { name: "贵州茅台", price: 9, pct: null, high: 11, low: 9, prevClose: null, limitUp: 11, limitDown: 9 },
    },
    watch: [{ secid: "1.600519", code: "600519", name: "G", limit: true }],
    alerted: {},
    today: TODAY,
  });
  eq("有交易所价时跌停价到、pct 为 null 也报 limitDown", down[0]?.kind, "limitDown");

  // 6) -1/0 表示该源这次不供：必须按 null 走回落，绝不许拿 -1 参与比较（那会把每只都判成涨停）
  const bogus = R.evalAlerts({
    quotes: {
      "1.600519": { name: "贵州茅台", price: 10.5, pct: 5, high: 10.5, low: 10.4, prevClose: 10, limitUp: -1, limitDown: 0 },
    },
    watch: [{ secid: "1.600519", code: "600519", name: "G", limit: true }],
    alerted: {},
    today: TODAY,
  });
  eq("-1/0 的涨跌停价按不供处理：不许因 -1 误报", bogus.length, 0);
}

// 五类联合：kind 集合与 KINDS 一致
{
  const watch = [
    { secid: "1.600519", code: "600519", name: "A", upper: 1700 },
    { secid: "0.000001", code: "000001", name: "B", lower: 10 },
    { secid: "0.300750", code: "300750", name: "C", pct: 5 },
    { secid: "1.601127", code: "601127", name: "D", limit: true },
    { secid: "0.002594", code: "002594", name: "E", limit: true },
  ];
  const quotes = {
    "1.600519": { name: "A", price: 1700.5, pct: 1.2, high: 1705, low: 1690 },
    "0.000001": { name: "B", price: 9.98, pct: -2.1, high: 10.2, low: 9.9 },
    "0.300750": { name: "C", price: 200, pct: -6.2, high: 205, low: 198 },
    "1.601127": { name: "D", price: 11, pct: 10, high: 11, low: 10.4 },
    "0.002594": { name: "E", price: 24, pct: -10, high: 25, low: 24 },
  };
  const hits = R.evalAlerts({ quotes, watch, alerted: {}, today: TODAY });
  eq("五类联合：共 5 条命中", hits.length, 5);
  const kinds = [...new Set(hits.map((h) => h.kind))].sort();
  deep("五类联合：产出 kind 集合与 KINDS 一致", kinds, [...R.KINDS].sort());
}

// 不提醒的场景：停牌 / 缺行情 / 未设阈值 / limit:false
{
  const suspended = R.evalAlerts({
    quotes: { s: { name: "停牌股", price: null, pct: 0, high: 0, low: 0 } },
    watch: [{ secid: "s", code: "600000", upper: 1, lower: 9999, pct: 0.01, limit: true }],
    alerted: {},
    today: TODAY,
  });
  eq("price=null（停牌）不产生任何提醒", suspended.length, 0);

  const missing = R.evalAlerts({
    quotes: {},
    watch: [{ secid: "nope", code: "600000", upper: 1 }],
    alerted: {},
    today: TODAY,
  });
  eq("行情快照里没有这只：不提醒", missing.length, 0);

  const unset = R.evalAlerts({
    quotes: { s2: { name: "没设阈值", price: 123, pct: 5, high: 200, low: 100 } },
    watch: [{ secid: "s2", code: "000001" }],
    alerted: {},
    today: TODAY,
  });
  eq("未设任何阈值的自选不提醒", unset.length, 0);

  const off = R.evalAlerts({
    quotes: { s3: { name: "关掉市场规则", price: 11, pct: 10, high: 11, low: 10.4 } },
    watch: [{ secid: "s3", code: "600519", limit: false }],
    alerted: {},
    today: TODAY,
  });
  eq("limit:false 时市场规则关闭（涨停形态也不提醒）", off.length, 0);
}

// 去重：同一天不重复；写回后才生效
{
  const watch = [{ secid: "1.600519", code: "600519", upper: 1700 }];
  const quotes = { "1.600519": { name: "贵州茅台", price: 1700.5, pct: 1, high: 1705, low: 1690 } };
  const alerted = {};
  const first = R.evalAlerts({ quotes, watch, alerted, today: TODAY });
  eq("首轮产出 1 条", first.length, 1);
  const second = R.evalAlerts({ quotes, watch, alerted, today: TODAY });
  eq("未写回 alerted 时再次求值仍产出（去重由 alerted 表驱动）", second.length, 1);
  const ret = R.markAlerted(alerted, first, TODAY);
  check("markAlerted 就地返回同一个表", ret === alerted);
  const third = R.evalAlerts({ quotes, watch, alerted, today: TODAY });
  eq("markAlerted 写回后同一天不再重复产出", third.length, 0);
}

// markAlerted 的清理时机：标记时丢弃非当天的历史键（求值时不清理）
{
  const alerted = { "2026-10-01:600519:upper": true, "2026-10-12:000001:lower": true };
  R.evalAlerts({ quotes: {}, watch: [], alerted, today: TODAY });
  check("求值本身不清理历史键（清理发生在 markAlerted 时）", "2026-10-01:600519:upper" in alerted);
  R.markAlerted(alerted, [], TODAY);
  check("markAlerted 丢弃非当天的历史键", !("2026-10-01:600519:upper" in alerted));
  check("markAlerted 保留当天键", alerted["2026-10-12:000001:lower"] === true);
}

// ruleSummary 文案
eq("ruleSummary({}) = 未设提醒", R.ruleSummary({}), "未设提醒");
eq("ruleSummary 单阈值", R.ruleSummary({ upper: 10 }), "≥10");
eq("ruleSummary 组合含全部已设项", R.ruleSummary({ upper: 10, lower: 5, pct: 3, limit: true }), "≥10 ≤5 |涨跌|≥3% 涨跌停");
eq("ruleSummary 非数字阈值被忽略", R.ruleSummary({ upper: "abc", lower: null }), "未设提醒");
eq("ruleSummary limit 为真时带「涨跌停」", R.ruleSummary({ limit: 1 }), "涨跌停");

/* ============================ charts ============================ */
group = "charts";

// movingAverage：长度、前段 null、手算校验
{
  const bars = [10, 20, 30, 40, 50].map((close) => ({ close }));
  const ma2 = C.movingAverage(bars, 2);
  eq("ma：输出与输入等长", ma2.length, bars.length);
  eq("ma：前 span-1 项为 null", JSON.stringify([ma2[0]]), "[null]");
  eq("ma2 第 2 项手算 = 15", ma2[1], 15);
  eq("ma2 第 3 项手算 = 25", ma2[2], 25);
  eq("ma2 末项手算 = 45", ma2[4], 45);

  const ma3 = C.movingAverage(bars, 3);
  eq("ma3 前两项为 null", JSON.stringify([ma3[0], ma3[1]]), "[null,null]");
  eq("ma3 第 3 项手算 = 20", ma3[2], 20);
  eq("ma3 第 4 项手算 = 30", ma3[3], 30);
  eq("ma3 末项手算 = 40", ma3[4], 40);

  const ma5 = C.movingAverage(bars, 5);
  eq("ma：span 等于长度时前面仍为 null", JSON.stringify(ma5.slice(0, 4)), "[null,null,null,null]");
  eq("ma：span 等于长度时末项 = 全序列均值 30", ma5[4], 30);

  const ma9 = C.movingAverage(bars, 9);
  check("ma：窗口大于数据长度时全为 null", ma9.length === bars.length && ma9.every((v) => v === null));
  check("ma：span=0 全为 null", C.movingAverage(bars, 0).every((v) => v === null));
  check("ma：span 为负全为 null", C.movingAverage(bars, -3).every((v) => v === null));
  check("ma：空数组返回空数组", C.movingAverage([], 3).length === 0);
}

// depthRows：排序、weight、求和、null 档
{
  const depth = {
    asks: [
      { price: 10.5, volume: 10 },
      { price: 10.6, volume: 20 },
      { price: 10.7, volume: 30 },
      { price: 10.8, volume: 40 },
      { price: 10.9, volume: 50 },
    ],
    bids: [
      { price: 10.4, volume: 45 },
      { price: 10.3, volume: 25 },
      { price: null, volume: null },
      { price: 10.1, volume: 15 },
      { price: 10.0, volume: 5 },
    ],
    limitUp: 11.5,
    limitDown: 9.4,
  };
  const d = C.depthRows(depth);
  eq("depth：asks 长度", d.asks.length, 5);
  eq("depth：卖盘倒序（卖五→卖一）", d.asks.map((r) => r.tag).join(","), "卖5,卖4,卖3,卖2,卖1");
  eq("depth：买盘正序（买一→买五）", d.bids.map((r) => r.tag).join(","), "买1,买2,买3,买4,买5");
  eq("depth：倒序后首位是卖五价", d.asks[0].price, 10.9);
  eq("depth：倒序后末位是卖一价", d.asks[4].price, 10.5);
  eq("depth：side 字段", `${d.asks[0].side}|${d.bids[0].side}`, "ask|bid");
  eq("depth：全局最大量档 weight = 100", d.asks[0].weight, 100);
  eq("depth：卖一 weight = round(10/50*100) = 20", d.asks[4].weight, 20);
  eq("depth：买一（本侧最大 45）weight = round(45/50*100) = 90（归一基数是两侧合并最大值）", d.bids[0].weight, 90);
  check("depth：价格为 null 的档 weight = 0", d.bids[2].weight === 0);
  check("depth：价格为 null 的档 volume 保持 null（渲染层据此不显示量）", d.bids[2].volume === null);
  eq("depth：totalAsk = 各档求和 150", d.totalAsk, 150);
  eq("depth：totalBid 不把 null 计入 = 90", d.totalBid, 90);
  eq("depth：涨跌停透传", `${d.limitUp}|${d.limitDown}`, "11.5|9.4");
}

// depthRows：null 与空档位
{
  const d0 = C.depthRows(null);
  deep("depth：null 输入返回 {asks:[],bids:[]} 而不抛错", d0, { asks: [], bids: [] });
  const d1 = C.depthRows({ asks: [], bids: [] });
  check("depth：空档位总量为 0", d1.totalAsk === 0 && d1.totalBid === 0);
  check("depth：空档位不产生行", d1.asks.length === 0 && d1.bids.length === 0);
}

check(
  "COLORS.ma 是 3 条颜色（MA5/10/20）",
  Array.isArray(C.COLORS.ma) && C.COLORS.ma.length === 3 && C.COLORS.ma.every((c) => typeof c === "string"),
);
check("COLORS 涨/跌/平盘都是颜色字符串", [C.COLORS.up, C.COLORS.down, C.COLORS.flat].every((c) => typeof c === "string"));

/* ==================== sourceBranch（A11：源无关判定的离线钉） ==================== */
// 两种网络形态（全通 / 东财坏 / 只有新浪）下，判定层必须各自给出可解释的 PASS/FAIL ——
// 「今天网络正好是这样」不再影响结论，由这里离线钉住。判定层本身不许联网（纯函数）。
group = "sourceBranch";
{
  const B = await import(new URL("./astock-source-branch.mjs", import.meta.url).href);
  const H = {
    px: "push2.eastmoney.com",
    pxh: "push2his.eastmoney.com",
    qt: "qt.gtimg.cn",
    proxy: "proxy.finance.qq.com",
    web: "web.ifzq.gtimg.cn",
    ifzq: "ifzq.gtimg.cn",
    sina: "hq.sinajs.cn",
  };
  const ALL_UP = { [H.px]: true, [H.pxh]: true, [H.qt]: true, [H.proxy]: true, [H.web]: true, [H.ifzq]: true, [H.sina]: true };
  const EAST_DOWN = { ...ALL_UP, [H.px]: false, [H.pxh]: false }; // 老环境：东财整组不可达
  const SINA_ONLY = { ...ALL_UP, [H.px]: false, [H.pxh]: false, [H.qt]: false, [H.proxy]: false, [H.web]: false, [H.ifzq]: false };

  const verdict = (name, args, expectOk, reasonPart) => {
    const v = B.judgeKindSource(args);
    check(name, v.ok === expectOk && (!reasonPart || v.reason.includes(reasonPart)), `ok=${v.ok} ${v.reason}`);
  };
  const budgetOk = (name, args, expectOk, reasonPart) => {
    const v = B.requestBudget(args);
    check(name, v.ok === expectOk && (!reasonPart || v.reason.includes(reasonPart)), `ok=${v.ok} ${v.reason}`);
  };

  // —— host 表来自注册表（改源注册表这里自动跟） ——
  const hosts = B.allHosts().sort();
  check("allHosts 覆盖注册表全部入口（7 个）", hosts.length === 7 && Object.values(H).every((h) => hosts.includes(h)), hosts.join(","));

  // —— 可用源集合 ——
  deep("全通：快照三源都可用", B.availableFor("quote", ALL_UP), ["eastmoney", "tencent", "sina"]);
  deep("全通：K线两源都可用", B.availableFor("kline", ALL_UP), ["eastmoney", "tencent"]);
  deep("东财坏：快照退到腾讯/新浪", B.availableFor("quote", EAST_DOWN), ["tencent", "sina"]);
  deep("东财坏：K线只剩腾讯", B.availableFor("kline", EAST_DOWN), ["tencent"]);
  deep("只有新浪：快照只剩新浪", B.availableFor("quote", SINA_ONLY), ["sina"]);
  deep("只有新浪：K线没有可用源（新浪不供 K 线）", B.availableFor("kline", SINA_ONLY), []);
  deep("只有新浪：五档没有可用源（新浪不供五档）", B.availableFor("depth", SINA_ONLY), []);

  // —— 预期源：有记忆用记忆；没有才是注册表首位。**不看 preflight**（根通≠接口通，2026-10-12 现场） ——
  eq("预期源：无记忆取注册表首位", B.firstExpected("kline"), "eastmoney");
  eq("预期源：有记忆就用记忆", B.firstExpected("kline", "tencent"), "tencent");
  eq("预期源：记忆直通、preflight 全灭也照样是记忆", B.firstExpected("kline", "tencent"), "tencent");

  // —— judgeKindSource：预期 = 记忆/注册表首位；换源必须带失败证据（§10 修订口径） ——
  verdict("无记忆：用注册表首位 → PASS", { kind: "kline", observed: "eastmoney", reachable: ALL_UP }, true, "无记忆时取注册表首位");
  verdict("无记忆：无失败却用次位 → 判红", { kind: "kline", observed: "tencent", reachable: ALL_UP }, false, "没有任何失败证据");
  verdict("无记忆：次位但有失败记录解释 → PASS", { kind: "kline", observed: "tencent", reachable: ALL_UP, hadFailure: true }, true, "失败过");
  // §10 放行条件①的两条现场形态（PM 那轮就是记忆=tencent、observed=tencent）
  verdict("记忆=tencent 且 observed=tencent → PASS（先试上次成功的源）", { kind: "kline", observed: "tencent", preferred: "tencent", reachable: ALL_UP }, true, "先试上次成功的源");
  verdict("记忆=tencent 且 observed=eastmoney 且无失败证据 → 判红", { kind: "kline", observed: "eastmoney", preferred: "tencent", reachable: ALL_UP }, false, "没有任何失败证据");
  verdict("记忆=tencent 且 observed=eastmoney 且有失败记录 → PASS（记忆源失败过，回落）", { kind: "kline", observed: "eastmoney", preferred: "tencent", reachable: ALL_UP, hadFailure: true }, true, "失败过");
  // 「整条链全失败」不上回显，但「预期源先失败、换源成功」由 pnl.attempted 记录（插件只增不改的回显字段）
  verdict("无记忆：次位且有『尝试记录』证据 → PASS（东财 API 失败过，正是本轮现场）", { kind: "kline", observed: "tencent", reachable: ALL_UP, attemptedFailures: 1 }, true, "失败过");
  verdict("尝试记录为空且无整段失败 → 仍判红（不因新证据字段恒真）", { kind: "kline", observed: "tencent", reachable: ALL_UP, attemptedFailures: 0 }, false, "没有任何失败证据");
  verdict("记忆=tencent 且 preflight 判它不可达、observed 仍是腾讯 → PASS（preflight 不当真值）", { kind: "quote", observed: "tencent", preferred: "tencent", reachable: EAST_DOWN }, true, "先试上次成功的源");
  verdict("该段没数据但失败明细在 → 正确降级 PASS", { kind: "kline", observed: null, hadFailure: true, reachable: ALL_UP }, true, "正确降级");
  verdict("该段没数据且没有失败明细 → 判红", { kind: "kline", observed: null, reachable: ALL_UP }, false, "没有数据、也没有失败明细");
  verdict("该段没数据 + 全不可达 → 正确降级 PASS", { kind: "kline", observed: null, reachable: SINA_ONLY }, true, "正确降级");
  verdict("未知源一律判红", { kind: "kline", observed: "weird", reachable: ALL_UP }, false, "不在已知源表");

  // —— requestBudget：同档时不许撞源（本卡唯一变严处的离线镜像）；真换过源才放宽 ——
  budgetOk("同档（记忆=observed）：1 次 → 在预算内", { kind: "quote", requests: 1, preferred: "tencent", observed: "tencent" }, true);
  budgetOk("同档：2 次（传输层重试余量）→ 仍在预算内", { kind: "quote", requests: 2, preferred: "tencent", observed: "tencent" }, true);
  budgetOk("同档：3 次 → 判红（撞多家）", { kind: "quote", requests: 3, preferred: "tencent", observed: "tencent" }, false, "撞多家即判红");
  budgetOk("无记忆同档（observed=注册表首位）：2 次 → 在预算内", { kind: "quote", requests: 2, observed: "eastmoney" }, true);
  budgetOk("无记忆同档：3 次 → 判红", { kind: "quote", requests: 3, observed: "eastmoney" }, false, "撞多家即判红");
  budgetOk("换过源（无记忆、observed≠首位）：quote 3 次 → 放宽档内", { kind: "quote", requests: 3, observed: "tencent" }, true);
  budgetOk("换过源：quote 7 次（3 源 → 上限 6）→ 判红", { kind: "quote", requests: 7, observed: "tencent" }, false);
  budgetOk("换过源：kline 3 次（2 源 → 上限 4）→ 放宽档内", { kind: "kline", requests: 3, observed: "tencent" }, true);
  budgetOk("换过源：kline 5 次 → 判红", { kind: "kline", requests: 5, observed: "tencent" }, false);

  {
    const PRE_SAME = { depth: "tencent", trend: "tencent", kline: "tencent" };
    const OBS_SAME = { depth: "tencent", trend: "tencent", kline: "tencent" };
    const m1 = B.requestBudgetMany({ kinds: ["depth", "trend", "kline"], requests: 3, preferred: PRE_SAME, observed: OBS_SAME });
    check("面板三条链都命中记忆：3 次 → 在预算内、且是紧档", m1.ok === true && m1.allSameTier === true, m1.reason);
    const m2 = B.requestBudgetMany({ kinds: ["depth", "trend", "kline"], requests: 7, preferred: PRE_SAME, observed: OBS_SAME });
    check("面板三条链都命中记忆：7 次 → 判红", m2.ok === false, m2.reason);
    const m3 = B.requestBudgetMany({ kinds: ["depth", "trend", "kline"], requests: 9, preferred: {}, observed: { depth: "tencent", trend: "tencent", kline: "tencent" } });
    check("面板无记忆、实际换过源：9 次 → 放宽档内（PM 现场形态）", m3.ok === true && m3.allSameTier === false, m3.reason);
  }
}

/* ============================ 汇总 ============================ */
console.log(`[throttle] ${attempts.throttle}`);
console.log(`[rules] ${attempts.rules}`);
console.log(`[charts] ${attempts.charts}`);
console.log(`[sourceBranch] ${attempts.sourceBranch}`);
console.log(`RESULT pass=${pass} fail=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
