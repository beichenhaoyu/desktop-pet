// A股盯盘主逻辑，运行在宠物窗上下文。
//
// 分工：market.js 只管取数与解析，rules.js 只管判定，这个文件负责
// 「什么时候问一次、问完拿结果干什么、怎么落盘」。
//
// 三条刻意的设计，改之前先看注释：
//   1) 提醒不看「是不是交易日」而看「行情时间戳有没有前进」—— 法定节假日接口给的是
//      上一交易日的旧数据，判时间戳比维护一份节假日日历可靠。
//   2) 一轮 tick 只允许有一个在飞请求（busy 标志），否则网络卡顿时定时器会排队堆请求。
//   3) 界面数据每轮都 ctx.widget.update 一次，设置页重新挂载时靠宿主回灌，
//      否则面板会拿自己的默认值去覆盖用户已经存好的配置。
import {
  TOPIC_ALERT,
  TOPIC_CHANGED,
  TOPIC_CMD,
  TOPIC_PANEL,
  TOPIC_QUOTE,
  TOPIC_STATUS,
  TOPIC_SUGGEST,
} from "./topics.js";
import {
  briefReason,
  fetchDepth,
  fetchKline,
  fetchQuotes,
  fetchSuggest,
  fetchTrend,
  KIND_NAMES,
  KLT_VALUES,
  marketSession,
  normalizeCode,
  progressOf,
  secidOf,
  SOURCE_IDS,
  sourceLabelOf,
} from "./market.js";
import { evalAlerts, markAlerted } from "./rules.js";
import {
  cooldownMs,
  createGate,
  FAILS_BEFORE_COOLDOWN,
  isThrottleError,
  isTransportError,
  jittered,
  nextIntervalSec,
} from "./throttle.js";

const DEFAULT_CONFIG = {
  intervalSec: 20, // 盘中轮询间隔
  idleIntervalSec: 300, // 非盘中/休市时的间隔：没必要按秒打接口
  alertsOn: true,
  petOn: true,
  showIndex: true,
  indexSecid: "1.000001",
  mode: "badge", // badge | overlay | off
};

/** 轮询间隔下限：再小就是在压公共接口，个人盯盘也没这个必要 */
const MIN_INTERVAL = 10;
const MAX_WATCH = 20;
/** 界面上保留的最近提醒条数 */
const RECENT_ALERTS = 8;
/** K 线比盘口/分时候份稳定得多，60 秒才重拉一次 */
const KLINE_STALE_MS = 60_000;
/** 设置页开着的时候会每分钟续一次期；人走了（关窗/切到别的插件页）就没人续，90 秒后自动停 */
const PANEL_TTL_MS = 90_000;

let ctx = null;
let config = { ...DEFAULT_CONFIG };
let watch = []; // [{secid, code, name, upper, lower, pct, limit}]
let quotes = {}; // secid → quote
let alerted = {}; // "日期:代码:规则" → true
let recent = []; // 最近提醒，给界面显示
let timer = 0;
let busy = false;
let lastQuoteAt = 0;
let lastError = "";
let stopped = false;

/* 选中个股的盘口 / 分时 / K 线：只有设置页在用，走单独 topic，不进每轮的 *:widget */
let selected = "";
let klt = 101;
let panel = null; // { secid, klt, depth, trend, kline, error, failed, at }
let panelWanted = false;
let panelAt = 0;
let panelBusy = false;
/**
 * 「上一次成功的源」：K线、分时、行情快照、五档各记一个 id，落在插件自己的隔离存储里（key: sources），
 * 重启后第一轮就先用它 —— 坏源不必每轮都再撞一次。插件页那行「K线数据源 腾讯」也是它。
 */
let sourcePrefs = { kline: "", trend: "", quote: "", depth: "" };
/** 上一轮行情是哪家给的：切源那一轮不判「有没有进展」（两个源对同一时刻的措辞可能差几十分钟） */
let lastQuoteSource = "";
/** 悬浮窗显隐的串行链，见 syncOverlay() */
let overlayChain = Promise.resolve();

/* 出网节制：所有请求都必须过 out()，别绕过去直接调 ctx.http.request */
const gate = createGate();
let strikes = 0; // 被判定为限流的次数，决定冷却阶梯
let cooldownUntil = 0; // 冷却到什么时候（毫秒时间戳）
let fails = 0; // 连续普通失败次数
let noProgress = 0; // 连续多少轮行情时间戳没前进（休市/停牌/节假日）
let targetSec = 0; // 当前生效的未抖动间隔，用于判断要不要重建定时器

function clockText(ms) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function enterCooldown(reason) {
  strikes += 1;
  cooldownUntil = Date.now() + cooldownMs(strikes);
  lastError = `接口在限流（${reason}），暂停到 ${clockText(cooldownUntil)}`;
  status(lastError, "error");
}

/**
 * 唯一的出网口子：冷却 → 闸门（最小间隔 + 每分钟上限）→ 请求 → 记账。
 * 传输层失败（连接被掐）在这里重试一次，所以面板/主轮询/搜索三条路径都能享受到，
 * 不用各自再写一遍；429/403 与「连续多次失败」则进冷却阶梯 —— 被拒之后继续按原节奏撞，
 * 等于把一次临时限流坐实成长期封禁。
 */
async function out(url, opts) {
  if (!ctx) throw new Error("插件已停用");
  const check = () => {
    const now = Date.now();
    if (now < cooldownUntil) {
      const err = new Error(`限流冷却中，约 ${Math.ceil((cooldownUntil - now) / 1000)} 秒后自动恢复`);
      err.cooldown = true;
      throw err;
    }
  };
  const once = async () => {
    check();
    await gate.acquire();
    const resp = await ctx.http.request(url, opts);
    if (isThrottleError(resp)) enterCooldown(`HTTP ${resp.status}`);
    return resp;
  };
  try {
    const resp = await once();
    fails = 0;
    return resp;
  } catch (err) {
    if (err?.cooldown) throw err;
    if (isThrottleError(err)) {
      enterCooldown(String(err?.message ?? err));
      throw err;
    }
    if (!isTransportError(err)) {
      countFailure(err);
      throw err;
    }
    try {
      const resp = await once();
      fails = 0;
      return resp;
    } catch (err2) {
      if (!err2?.cooldown) countFailure(err2);
      throw err2;
    }
  }
}

function countFailure(err) {
  if (isThrottleError(err)) return enterCooldown(String(err?.message ?? err));
  fails += 1;
  if (fails >= FAILS_BEFORE_COOLDOWN) enterCooldown(`连续 ${fails} 次请求失败`);
  return undefined;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level, at: Date.now() });
}

function watchSecids() {
  const ids = watch.map((w) => w.secid);
  if (config.showIndex && config.indexSecid) ids.push(config.indexSecid);
  return [...new Set(ids.filter(Boolean))];
}

async function persist(keys) {
  const all = keys ?? ["watch", "config", "alerted"];
  try {
    for (const key of all) {
      const value = key === "watch" ? watch : key === "config" ? config : key === "sources" ? sourcePrefs : alerted;
      await ctx.storage.set(key, value);
    }
  } catch (err) {
    ctx?.log?.("保存盯盘配置失败", err);
  }
}

/**
 * 记下「这一段上一次成功的源」并落盘（只在变化时写）。第一次成功也写：
 * 之后重启插件，第一轮就先用它 —— 上一次被重置的那个源不必每轮再撞一遍。
 */
function noteSource(kind, id, host) {
  if (!id || sourcePrefs[kind] === id) return;
  sourcePrefs = { ...sourcePrefs, [kind]: id };
  ctx?.log?.(`${KIND_NAMES[kind]}数据源切到 ${sourceLabelOf(id)}（${host}）`);
  void persist(["sources"]);
}

/** 推给 badge / overlay / 插件页的同一份视图：界面只读它，不自己算 */
function pushState() {
  const session = marketSession();
  const now = Date.now();
  ctx?.widget.update({
    config,
    watch: watch.map((w) => ({ ...w, rule: ruleText(w) })),
    quotes,
    session,
    recent,
    error: lastError,
    updatedAt: now,
    quoteAt: lastQuoteAt,
    /** 出网节制对用户可见：为什么没更新、还要等多久，别让人以为插件挂了 */
    net: {
      ...gate.stats(),
      strikes,
      cooldownLeftSec: cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0,
      noProgress,
      intervalSec: targetSec || currentIntervalSec(),
      /** 当前吃的是哪家的数据（K线/分时各自记）：插件页那行「K线数据源 腾讯」就来自这里 */
      sources: { ...sourcePrefs },
    },
  });
}

function ruleText(item) {
  const parts = [];
  if (Number.isFinite(item.upper)) parts.push(`≥${item.upper}`);
  if (Number.isFinite(item.lower)) parts.push(`≤${item.lower}`);
  if (Number.isFinite(item.pct)) parts.push(`|±|≥${item.pct}%`);
  if (item.limit !== false) parts.push("涨跌停");
  return parts.join(" ") || "未设提醒";
}

/** 面板数据单独一条 topic：badge/overlay 收的是每轮的 *:widget，用不着几十 KB 的序列 */
function publishPanel() {
  ctx?.bus.publish(TOPIC_PANEL, panel ?? { secid: "", cleared: true, at: Date.now() });
}

function clearPanel() {
  selected = "";
  panel = null;
  panelWanted = false;
  publishPanel();
}

/**
 * 宿主代理的原始错误里带着整条 URL 和 rustls 的文档链接，对用户没用还会把面板那行撑成三行；
 * 完整信息进 ctx.log（多源失败时每个入口一条，见 market.js 抛出的 err.detail），界面上只留人话。
 */
function briefError(err) {
  return briefReason(err).slice(0, 90);
}

/**
 * 拉选中个股的盘口 / 分时 / K 线。三段可以分开要：切 K 线周期时没必要把盘口和分时再打一遍。
 * 失败不牵动主轮询，但**失败的那一段不保留上一轮的数据**（序列摘成 null，界面留错误行 + 空提示）：
 * 尤其是切周期，把上一周期的 K 线挂在新周期标签下，就是一张错价的图。
 * K线与分时走多源（见 market.js）：先试上一次成功的源，失败依次下移，全失败才落成一行错误。
 */
async function loadPanel({ withDepth = true, withTrend = true, withKline = true } = {}) {
  if (!ctx || !selected || panelBusy) return;
  panelBusy = true;
  panelWanted = true;
  panelAt = Date.now();
  const request = out;
  // 换标的时不继承上一只的曲线，否则名字是 A、图上画的是 B
  const next = { ...(panel?.secid === selected ? panel : {}), secid: selected, klt, error: "", failed: {} };
  // 切周期先把上一周期的 K 线摘掉：它比失败处理更早生效，
  // 否则「请求还没回来」的那几秒里，新周期标签下挂的仍是旧周期的图
  if (next.klineKlt !== klt) {
    next.kline = null;
    next.klineKlt = null;
    next.klineAt = 0;
  }
  const failed = {};

  // 每一类数据「这一轮试过的源」：只做记录（host + 成败），不改取数顺序、out() 与节流 ——
  // 「整条链失败」有 failed 兜底，但「先撞预期源失败、再换源成功」的中途失败不上任何回显字段，
  // 回归的判定层靠这份记录把「有理由的跨源」和「无理由跨源」分开（见 tests/e2e/harness/astock-source-branch.mjs）。
  const attempted = {};
  const traced = (kind) => {
    const rec = [];
    attempted[kind] = rec;
    return async (url, opts) => {
      const entry = { host: new URL(url).hostname, ok: null };
      rec.push(entry);
      try {
        const resp = await request(url, opts);
        entry.ok = true;
        return resp;
      } catch (err) {
        entry.ok = false;
        throw err;
      }
    };
  };

  /** 一段取数：成功写进 next，失败只记自己那一段（一段坏不连坐另外两段） */
  const grab = async (kind, run) => {
    try {
      await run();
    } catch (err) {
      failed[kind] = briefError(err);
      ctx?.log?.(`${KIND_NAMES[kind]}取数失败`, err?.detail ?? err);
    }
  };
  const grabDepth = () =>
    grab("depth", async () => {
      const { data, source, host } = await fetchDepth(traced("depth"), selected, { preferred: sourcePrefs.depth });
      next.depth = data;
      next.depthAt = Date.now();
      next.depthSource = source;
      noteSource("depth", source, host);
    });
  const grabTrend = () =>
    grab("trend", async () => {
      const { data, source, host } = await fetchTrend(traced("trend"), selected, { preferred: sourcePrefs.trend });
      // 昨收优先取**主轮询那一份快照**（缓存复用）：同一个数不重复问，
      // 而且分时基线跟着列表里的昨收走，不会出现「列表一个昨收、图上一个昨收」。
      // 快照这一轮没成功（或这只不在自选里）时才退回分时响应自带的那个。
      const cached = quotes[selected]?.prevClose;
      next.trend = Number.isFinite(cached) ? { ...data, preClose: cached } : data;
      next.trendAt = Date.now();
      next.trendSource = source;
      noteSource("trend", source, host);
    });
  const grabKline = () =>
    grab("kline", async () => {
      const { data, source, host } = await fetchKline(traced("kline"), selected, klt, { preferred: sourcePrefs.kline });
      next.kline = data;
      next.klineAt = Date.now();
      next.klineKlt = klt;
      next.klineSource = source;
      noteSource("kline", source, host);
    });

  try {
    // 三段**按顺序**取，不要 Promise.all：出网闸门的「连续失败」是全插件一份计数，
    // 三条链并发时，盘口 + 分时 + K线各自要先撞一次坏源（东财整组被重置），
    // 三次失败会在分时/ K线 还没轮到备用源时就把插件推进冷却（实测：面板一轮里
    // depth 失败、trend/kline 直接拿到「限流冷却中，约 300 秒后自动恢复」，备用源根本没跑到）。
    // 串起来之后每段都是「先撞坏源、再换源成功」，成功会把计数清零，冷却不会被误触发。
    if (withDepth) await grabDepth();
    if (withTrend) await grabTrend();
    if (withKline && (next.klineKlt !== klt || isKlineStale(next) || !next.kline)) await grabKline();

    // 失败的那一段：不把上一轮的序列当本轮结果发布（宁可图上写「还没有数据」）
    if (failed.depth) {
      next.depth = null;
      next.depthAt = 0;
    }
    if (failed.trend) {
      next.trend = null;
      next.trendAt = 0;
    }
    if (failed.kline) {
      next.kline = null;
      next.klineKlt = null;
      next.klineAt = 0;
    }
    next.failed = failed;
    /** 只增不改的归因字段：每类数据本轮试过的源（host + 成败），取数/判定逻辑不受它影响 */
    next.attempted = attempted;
    next.error = Object.entries(failed)
      .map(([kind, why]) => `${KIND_NAMES[kind]}：${why}`)
      .join("；");
    panel = { ...next, at: Date.now() };
    if (next.error) status(`盘面数据拉取失败：${next.error}`, "error");
  } finally {
    panelBusy = false;
    publishPanel();
  }
}

function isKlineStale(state) {
  return !Number.isFinite(state?.klineAt) || Date.now() - state.klineAt > KLINE_STALE_MS;
}

async function syncOverlayOnce() {
  const want = config.mode === "overlay";
  try {
    if (want) {
      // 盯盘卡放桌面左上角：贴在宠物头顶会挡住角色，也和心率波形抢同一块地方
      await ctx.overlay.show({ placement: "corner", height: 96 + 26 * Math.min(watch.length + 1, 8) });
    } else {
      await ctx.overlay.hide();
    }
  } catch (err) {
    ctx?.log?.("盯盘卡切换失败", err);
  }
}

/**
 * 显隐切换排成一条链。
 * 不排会输在收尾上：刚发出「删掉最后一只自选」的 show 还没落地就停用插件，
 * destroy 先到、show 后到，卡就留在屏幕上了（回归里就是这么炸的）。
 */
function syncOverlay() {
  overlayChain = overlayChain.then(async () => {
    if (stopped || !ctx) return; // 已经停用/还没就绪，这一跳直接作废
    await syncOverlayOnce();
  });
  return overlayChain;
}

/** 宠物反应：涨=开心，跌=沮丧，到价=提醒你看一眼 */
async function reactTo(hit) {
  if (!config.petOn) return;
  try {
    if (hit.kind === "limitUp") {
      await ctx.pet.react("jumping");
      await ctx.pet.say(hit.message);
    } else if (hit.kind === "limitDown") {
      await ctx.pet.react("failed");
      await ctx.pet.say(hit.message);
    } else {
      await ctx.pet.react("waiting");
      await ctx.pet.say(hit.message);
    }
  } catch (err) {
    ctx?.log?.("宠物反应失败", err); // 已停用或本体没就绪，不影响提醒本身
  }
}

async function fireAlerts(hits) {
  for (const hit of hits) {
    // 三条都得成功才算「今天提醒过了」：中途抛错就继续下一条，
    // 别让一次通知失败把整轮提醒打断，也别把没提醒的记成已提醒
    try {
      if (config.alertsOn) {
        await ctx.notify.show(hit.level === "down" ? "盯盘：下跌提醒" : "盯盘：上涨提醒", hit.message);
      }
      await reactTo(hit);
    } catch (err) {
      ctx?.log?.("提醒失败", err);
      continue;
    }
    recent = [{ ...hit, today: today() }, ...recent].slice(0, RECENT_ALERTS);
    ctx?.bus.publish(TOPIC_ALERT, hit);
  }
}

async function tick(reason = "timer") {
  if (!ctx || busy || watch.length === 0) {
    if (watch.length === 0) pushState();
    return;
  }
  if (reason === "timer" && Date.now() < cooldownUntil) {
    pushState(); // 界面上要看得见「为什么这几分钟没更新」
    return;
  }
  busy = true;
  try {
    const { data: rows, source, host } = await fetchQuotes(out, watchSecids(), { preferred: sourcePrefs.quote });
    const next = {};
    for (const q of rows) next[q.secid] = q;
    quotes = next;
    lastError = "";
    if (source) noteSource("quote", source, host);

    const session = marketSession();
    const newest = Math.max(0, ...rows.map((r) => r.quoteAt ?? 0));
    // 行情没前进 = 停牌/休市/节假日，这一轮不该产生任何提醒。
    // 时间戳已在解析层归一成毫秒，但**切源那一轮不判**（各家措辞差几十分钟，见 progressOf），
    // 否则换一次源就会被当成「涨了」白刷一轮、或者被当成「卡住了」把间隔退避到 30 分钟。
    const step = progressOf({ prevAt: lastQuoteAt, prevSource: lastQuoteSource, at: newest, source });
    const fresh = step.fresh;
    lastQuoteAt = newest || lastQuoteAt;
    if (source) lastQuoteSource = source;
    // 连续没进展就把间隔按 2 的幂拉长到 30 分钟封顶：休市还 7×24 每几分钟打一次，
    // 是这套接口最像爬虫的地方；一有进展立刻回到正常节奏
    if (step.counted) noProgress = fresh ? 0 : noProgress + 1;
    if (currentIntervalSec() !== targetSec) restartTimer();

    if (config.alertsOn && fresh && session.trading) {
      const hits = evalAlerts({ quotes, watch, alerted, today: today() });
      if (hits.length) {
        markAlerted(alerted, hits, today());
        await fireAlerts(hits);
        await persist(["alerted"]);
      }
    }
    // 面板只在「设置页还要它」且没在冷却的时候跟着行情刷新
    if (panelWanted && session.trading && fresh && Date.now() - panelAt < PANEL_TTL_MS && Date.now() >= cooldownUntil) {
      void loadPanel();
    }
    ctx?.bus.publish(TOPIC_QUOTE, { count: rows.length, reason, session });
  } catch (err) {
    // 一个源都没成时**把行情清空**：留着上一轮的价格再配一个「刚刚更新」的时间，
    // 就是把旧数据当新数据广播（与面板失败时摘掉序列是同一条规矩），界面显示「—」+ 错误行
    quotes = {};
    if (!err?.cooldown) {
      lastError = String(err?.message ?? err);
      status(`行情拉取失败：${lastError}`, "error");
    }
  } finally {
    busy = false;
    pushState();
  }
}

/** 当前该用多长的间隔（未抖动）。冷却期由 tick 自己跳过，不参与间隔计算 */
function currentIntervalSec() {
  const trading = marketSession().trading;
  return nextIntervalSec({
    tradingSec: Math.max(MIN_INTERVAL, config.intervalSec),
    idleSec: Math.max(MIN_INTERVAL, config.idleIntervalSec),
    noProgress: trading ? 0 : noProgress,
  });
}

function restartTimer() {
  if (timer) clearInterval(timer);
  targetSec = currentIntervalSec();
  const fire = jittered(targetSec);
  timer = setInterval(() => {
    // 跨午休/收盘边界、或退避档位变了，就重建定时器，不必等下一次改配置
    if (currentIntervalSec() !== targetSec) {
      restartTimer();
      return;
    }
    void tick();
  }, fire * 1000);
}

async function afterChange(note) {
  restartTimer();
  await persist(["watch", "config"]);
  pushState();
  ctx?.bus.publish(TOPIC_CHANGED, { count: watch.length, mode: config.mode });
  await syncOverlay();
  if (note) status(note, "ok");
}

function clampNum(v) {
  const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : null;
}

/** 加自选：优先用界面给定的 secid（来自 suggest），否则按代码规则推 */
function resolveTarget(cmd) {
  if (typeof cmd.secid === "string" && /^\d\.\d{6}$/.test(cmd.secid)) {
    const code = cmd.secid.slice(2);
    return { secid: cmd.secid, code, name: typeof cmd.name === "string" ? cmd.name.slice(0, 40) : code };
  }
  const code = normalizeCode(cmd.input ?? cmd.code);
  if (!code) return null;
  const id = secidOf(code);
  return id ? { secid: id, code, name: typeof cmd.name === "string" ? cmd.name.slice(0, 40) : code } : null;
}

async function handleCmd(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "sync":
      pushState();
      publishPanel();
      return;
    case "refresh":
      await tick("manual");
      status(`已刷新：${Object.keys(quotes).length} 条`, "ok");
      return;
    case "add": {
      const target = resolveTarget(cmd);
      if (!target) {
        status("给我 6 位代码，或者从搜索结果里点「添加」", "error");
        return;
      }
      if (watch.some((w) => w.secid === target.secid)) {
        status(`${target.name} 已经在自选里了`, "error");
        return;
      }
      if (watch.length >= MAX_WATCH) {
        status(`自选股最多 ${MAX_WATCH} 只`, "error");
        return;
      }
      watch.push({ ...target, upper: null, lower: null, pct: null, limit: true });
      await afterChange(`已加入 ${target.name}`);
      await tick("added");
      return;
    }
    case "remove": {
      const before = watch.length;
      watch = watch.filter((w) => w.secid !== cmd.secid);
      if (watch.length !== before) {
        // 正开着的那只被删掉，面板不能继续画它的曲线
        if (cmd.secid === selected) clearPanel();
        await afterChange("已删除一只自选股");
      }
      return;
    }
    case "update": {
      const item = watch.find((w) => w.secid === cmd.secid);
      if (!item) return;
      // 只认这三个规则字段：界面上没给的（undefined）保持原值，别抹成 null
      if (cmd.upper !== undefined) item.upper = clampNum(cmd.upper);
      if (cmd.lower !== undefined) item.lower = clampNum(cmd.lower);
      if (cmd.pct !== undefined) item.pct = clampNum(cmd.pct);
      if (cmd.limit !== undefined) item.limit = cmd.limit === true;
      await afterChange(`已更新 ${item.name} 的提醒规则`);
      return;
    }
    case "clear": {
      watch = [];
      clearPanel();
      await afterChange("已清空自选股");
      return;
    }
    case "config": {
      const c = cmd.value ?? {};
      if (c.intervalSec !== undefined) {
        const n = clampNum(c.intervalSec);
        config.intervalSec = Math.max(MIN_INTERVAL, Math.round(n ?? DEFAULT_CONFIG.intervalSec));
      }
      if (c.idleIntervalSec !== undefined) {
        const n = clampNum(c.idleIntervalSec);
        config.idleIntervalSec = Math.max(60, Math.round(n ?? DEFAULT_CONFIG.idleIntervalSec));
      }
      if (c.alertsOn !== undefined) config.alertsOn = c.alertsOn === true;
      if (c.petOn !== undefined) config.petOn = c.petOn === true;
      if (c.showIndex !== undefined) config.showIndex = c.showIndex === true;
      if (typeof c.indexSecid === "string" && /^\d\.\d{6}$/.test(c.indexSecid)) {
        config.indexSecid = c.indexSecid;
      }
      if (c.mode === "badge" || c.mode === "overlay" || c.mode === "off") config.mode = c.mode;
      await afterChange(`刷新间隔 ${config.intervalSec}s、提醒 ${config.alertsOn ? "开" : "关"}`);
      return;
    }
    case "search": {
      const kw = String(cmd.keyword ?? "").trim();
      if (!kw) return;
      try {
        const rows = await fetchSuggest(out, kw);
        ctx?.bus.publish(TOPIC_SUGGEST, { keyword: kw, rows });
        if (!rows.length) status(`没找到与「${kw}」匹配的股票`, "error");
      } catch (err) {
        status(`搜索失败：${String(err?.message ?? err)}`, "error");
      }
      return;
    }
    case "select": {
      const secid = typeof cmd.secid === "string" ? cmd.secid : "";
      if (!/^\d\.\d{6}$/.test(secid) || !watch.some((w) => w.secid === secid)) {
        status("要点开一只自选股才能看盘口和曲线", "error");
        return;
      }
      selected = secid;
      await loadPanel();
      return;
    }
    case "klt": {
      const value = Number(cmd.value);
      if (!KLT_VALUES.includes(value)) {
        status(`不支持的K线周期: ${String(cmd.value)}`, "error");
        return;
      }
      klt = value;
      // 切周期只需要重拉 K 线，盘口和分时上一轮刚取过
      await loadPanel({ withDepth: false, withTrend: false });
      return;
    }
    case "panel":
      if (!selected) {
        status("还没选中自选股", "error");
        return;
      }
      await loadPanel();
      status(panel?.error ? `刷新失败：${panel.error}` : "盘面数据已刷新", panel?.error ? "error" : "ok");
      return;
    case "testAlert": {
      // 界面上的「试一下」：绕开按日去重，验证通知与宠物反应这条链路通不通
      const hit = {
        key: `test:${Date.now()}`,
        kind: "upper",
        secid: "test",
        code: "TEST",
        name: "测试",
        message: "这是一条盯盘测试提醒",
        level: "up",
        at: Date.now(),
      };
      await fireAlerts([hit]);
      pushState();
      status("测试提醒已发出", "ok");
      return;
    }
    default:
      status(`未知指令: ${String(cmd.action)}`, "error");
  }
}

function restore(key, saved, fallback) {
  if (key === "watch") {
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((w) => w && typeof w.secid === "string" && /^\d\.\d{6}$/.test(w.secid))
      .slice(0, MAX_WATCH)
      .map((w) => ({
        secid: w.secid,
        code: typeof w.code === "string" ? w.code : w.secid.slice(2),
        name: typeof w.name === "string" ? w.name.slice(0, 40) : w.code,
        upper: clampNum(w.upper),
        lower: clampNum(w.lower),
        pct: clampNum(w.pct),
        limit: w.limit !== false,
      }));
  }
  if (key === "config") {
    if (!saved || typeof saved !== "object") return { ...DEFAULT_CONFIG };
    return {
      intervalSec: Math.max(MIN_INTERVAL, clampNum(saved.intervalSec) ?? DEFAULT_CONFIG.intervalSec),
      idleIntervalSec: Math.max(60, clampNum(saved.idleIntervalSec) ?? DEFAULT_CONFIG.idleIntervalSec),
      alertsOn: saved.alertsOn !== false,
      petOn: saved.petOn !== false,
      showIndex: saved.showIndex !== false,
      indexSecid: typeof saved.indexSecid === "string" ? saved.indexSecid : DEFAULT_CONFIG.indexSecid,
      mode: saved.mode === "overlay" || saved.mode === "off" ? saved.mode : "badge",
    };
  }
  // sources：只认已知的源 id（旧版本写的、手改的都当没记过，下一轮重新探一遍）
  if (key === "sources") {
    const s = saved && typeof saved === "object" ? saved : {};
    const pick = (v) => (typeof v === "string" && SOURCE_IDS.includes(v) ? v : "");
    return { kline: pick(s.kline), trend: pick(s.trend), quote: pick(s.quote), depth: pick(s.depth) };
  }
  // alerted：只收字符串键、布尔值，且必须是今天的日期前缀（旧日期的直接丢）
  if (saved && typeof saved === "object") {
    const keep = {};
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === "boolean" && typeof k === "string" && k.startsWith(`${today()}:`)) keep[k] = v;
    }
    return keep;
  }
  return fallback;
}

export async function activate(context) {
  stopped = false;
  ctx = context;

  for (const key of ["watch", "config", "alerted", "sources"]) {
    try {
      const saved = await ctx.storage.get(key);
      if (key === "watch") watch = restore("watch", saved, []);
      else if (key === "config") config = restore("config", saved, config);
      else if (key === "sources") sourcePrefs = restore("sources", saved, sourcePrefs);
      else alerted = restore("alerted", saved, {});
    } catch (err) {
      ctx.log?.(`读取 ${key} 失败`, err);
    }
  }

  ctx.bus.subscribe(TOPIC_CMD, (p) => void handleCmd(p));

  pushState();
  await syncOverlay();
  restartTimer();
  if (watch.length) void tick("startup");
  status(
    watch.length
      ? `盯 ${watch.length} 只，间隔 ${config.intervalSec}s`
      : "已就绪：到「A股盯盘」页面添加自选股",
  );
}

export async function deactivate() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = 0;
  // 等在飞的显隐切换落完再收窗，否则后到的 show 会把卡重新点亮
  try {
    await overlayChain;
  } catch {
    /* 链上的错误都在 syncOverlayOnce 里吞掉了 */
  }
  overlayChain = Promise.resolve();
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 没开过卡就没有卡 */
  }
  ctx = null;
  quotes = {};
  // 面板状态跟着插件一起下线，重新启用时由设置页重新 select，免得留着上一轮的在飞请求归属
  panel = null;
  selected = "";
  panelWanted = false;
  panelBusy = false;
  // sourcePrefs 不清：它就是「重启后还认」的那份记忆（storage 里的 sources），下次 activate 读回来
}
