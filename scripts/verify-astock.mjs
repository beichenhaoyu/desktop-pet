// A股盯盘插件的端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:astock
// 覆盖：授权（含按域名的 http 授权）、走宿主代理取行情（UTF-8 中文名是关键证据）、
// 自选增删与阈值落盘、badge/overlay/插件页三区渲染、选中个股的分时/K线/五档（含画布真的画出像素）、
// 提醒链路（系统通知 + 宠物反应）、停用后定时器与订阅回收，以及 K线/分时的多源 failover
// （注入失败 + 固定样例单测，不靠真断网）。跑完撤销授权并下线插件。
//
// 会在屏幕上弹出系统通知（一次「测试提醒」），并短暂开一扇左上角盯盘卡、把设置页点到插件页。
// 收盘后行情时间戳不前进，规则命中会被「本轮没有新数据」这道闸挡住 ——
// 那部分判定逻辑由 market.js / rules.js 的纯函数断言覆盖，这里只验链路。
// 分时/K线/五档取的是接口最近一次的数据，所以休市跑也断言得出结构，只有提醒那条要看时段。
// 东财行情主机（push2 / push2his）在本机被整组连接重置，所以「行情快照 / 五档」这几条断言
// 在当前网络下必然红（它们要等阶段二的腾讯/新浪快照后端 + 宿主 charset 解码），
// 但 K线/分时在本脚本里是走腾讯的，断言照旧成立 —— 见文末「多源 failover」一组。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";
import {
  attach,
  createReport,
  hostInvoke,
  listPages,
  openSettingsInvoker,
  reloadAndWait,
  waitForPage,
  waitUntil,
} from "./cdp.mjs";
import {
  fetchKline,
  fetchTrend,
  parseTencentKline,
  parseTencentMinuteRows,
  parseTencentTrend,
  tencentCodeOf,
} from "../plugins/com.pet.astock/market.js";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PID = "com.pet.astock";
const ENABLED_KEY = "host:enabled-plugins";
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("A股盯盘插件（dev）");

let stopped = false;
/**
 * 同意框按能力分批弹，必须整轮持续点「允许」；域名授权也是走同一个框。
 * 两个细节是踩出来的：① 框刚建好时页面还没解析完，`getElementById` 会拿到 null（实测报
 * `Cannot read properties of null`），所以同一扇窗里要点到成功为止；② 一扇已经失效的旧框
 * （对应的请求早结束了）会自己按「拒绝」关掉，不能让它挡住后面真在等的那些框 —— 每个 target 都点。
 * 窗口给得比整轮跑测更宽：本脚本要等两处 45 秒的 waitUntil（行情/盘口在当前网络下拿不到），
 * 后面还有多源 failover 那一段要按域名为腾讯弹一次同意框。
 */
async function pump(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (!stopped && Date.now() < until) {
    const targets = (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url));
    if (!targets.length) {
      await sleep(250);
      continue;
    }
    for (const target of targets) {
      try {
        const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
        try {
          // 按钮和 caps 列表要一次求值里点掉：点完窗口就关了，分两次求值会拿到空列表
          let caps = "";
          for (let i = 0; i < 6; i++) {
            caps = await cs.ev(`(() => {
              const b = document.getElementById('btn-allow');
              if (!b) return '';
              const list = [...document.querySelectorAll('#cap-list li')].map((n) => n.textContent).join(' ');
              b.click();
              return list;
            })()`);
            if (caps) break;
            await sleep(250); // 页面还没解析完，重试（6 次约 1.5s，远小于宿主 60s 的等待）
          }
          console.log(`  · 同意框${caps ? `已允许：${caps}` : "没等到按钮"}`);
        } finally {
          cs.close();
        }
      } catch (e) {
        console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
      }
    }
    await sleep(300);
  }
}

let c = null;
let settings = null;
let origEnabled = "[]";

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
  c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(c);
  origEnabled = await c.ev(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)}) ?? '[]'`);
  void pump(600_000);

  r.group("发现与能力声明");
  const manifest = (await invoke("plugins_list")).v?.find((m) => m.id === PID);
  r.check("manifest 被发现", true, !!manifest);
  r.check("声明了 http（行情要出网）", true, (manifest?.permissions ?? []).includes("http"));
  r.check("声明了 overlay / notify / pet:say", true, ["overlay", "notify", "pet:say"].every((p) => (manifest?.permissions ?? []).includes(p)));
  r.check("没有声明它用不到的能力（ble 等）", false, (manifest?.permissions ?? []).some((p) => p.startsWith("ble")));

  // 从干净状态开始：撤销授权会连带清掉插件存储目录，避免上一轮的自选股干扰断言
  settings = await openSettingsInvoker(PORT, c);
  await settings.invoke("permission_revoke", { pluginId: PID });
  await sleep(1200);

  r.group("启用并授权");
  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    rt.setEnabledIds([...(JSON.parse(${JSON.stringify(origEnabled)}) ?? []), ${JSON.stringify(PID)}]);
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PID)}));
    return rt.isActive(${JSON.stringify(PID)});
  })()`);
  r.check("插件已激活", true, await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`));

  /** 读一份 `*:widget` 视图（宿主会回灌最近一份，publish sync 就够） */
  const readView = () => c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (x) => { off(); res(x); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" });
      setTimeout(() => { off(); res(null); }, 5000);
    });
  })()`);

  // 第一次出网要按域名授权：让插件真跑一次搜索，把 http + http:<host> 的同意框弹出来
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    window.__bus = bus;
    window.__seen = { quote: [], alert: [], status: [], suggest: [], panel: [] };
    for (const k of ['quote', 'alert', 'status', 'suggest', 'panel']) {
      bus.subscribe(${JSON.stringify(`${PID}:`)} + k, (p) => window.__seen[k].push(p));
    }
    return true;
  })()`);

  // 轮询间隔调到上限：行情快照后端（push2）在本机整组被连接重置，而行情是每轮都要打的，
  // 20 秒一次的失败攒够 3 次就会把整个插件的出网推进冷却（这是插件的正确行为，见 throttle.js），
  // 于是「面板的多源切换」「出网计数」这些断言根本观察不到。这一轮验的是 K线/分时的多源面板
  // （行情快照与五档是阶段二的事，不在这一轮），所以先把行情按住，面板那组开跑前再等冷却过去。
  // 这不是放宽断言：行情快照/五档那几条该怎么红还怎么红。
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { intervalSec: 1800, idleIntervalSec: 1800 } })}); true`);
  await sleep(800);
  r.check("轮询间隔已预置成上限（按住行情，好让面板在没冷却的窗口里验）", 1800, (await readView())?.net?.intervalSec);

  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "search", keyword: "茅台" }); true`);
  const gotSug = await waitUntil(c, `window.__seen.suggest.length > 0`, 40_000);
  r.check("按名称搜索有回音（http 授权已放行）", true, gotSug);
  const sugRows = (await c.ev(`window.__seen.suggest.at(-1)?.rows ?? []`)) ?? [];
  r.check("搜到 600519 且中文名没乱码", true, sugRows.some((s) => s.code === "600519" && /贵州茅台/.test(s.name ?? "")));

  r.group("加自选与行情");
  // 从空自选开始：撤销授权会清存储，但这一跑可能接在上一轮/别的会话之后，显式清一次，
  // 下面「只有我加的这两只」才钉得住
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "clear" }); true`);
  await sleep(800);
  const add = async (secid, code, name) => {
    await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "add", secid, code, name })})`);
    await sleep(1200);
  };
  await add("1.600519", "600519", "贵州茅台");
  await add("0.300750", "300750", "宁德时代");
  const stored = (await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? [];
  r.check("两只自选都落盘", ["1.600519", "0.300750"], stored.map((w) => w.secid));
  r.check("阈值字段是显式 null 而不是 undefined", [null, null], [stored[0]?.upper, stored[0]?.pct]);

  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "refresh" }); true`);
  const hasQuote = await waitUntil(c, `window.__seen.quote.length > 0`, 25_000);
  r.check("刷新后广播了行情快照", true, hasQuote);
  const view = (await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (d) => { off(); res(d); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" });
      setTimeout(() => { off(); res(null); }, 8000);
    });
  })()`));
  const q1 = view?.quotes?.["1.600519"];
  r.check("中文名来自宿主代理仍是 UTF-8", "贵州茅台", q1?.name);
  // 盘前（9:15 之前）接口会把个股的现价/涨跌幅打成 "-"，这是数据形态不是 bug，
  // 所以断言写成「同生同灭 + 脏值不落进界面」，任何时段都成立且仍能抓到解析层出错
  r.info("本轮时段", `${view?.session?.phase}${Number.isFinite(q1?.price) ? "（有实时成交价）" : "（无实时成交价，按盘前形态断言）"}`);
  r.check("现价与涨跌幅同生同灭（不会出现有价无幅或有幅无价）", true, Number.isFinite(q1?.price) === Number.isFinite(q1?.pct));
  // 行情这条路当前拿不到（push2 被整组重置，阶段二才接快照后端），所以这里不能崩：
  // 后面「面板：分时/K线」那一段不依赖它，崩了就整块看不到结果。断言本身一字未改。
  r.check("取不到的数值落成 null，不漏出 undefined 或字符串 '-'", true,
    ["price", "pct", "change", "prevClose", "volume"].every((k) => q1?.[k] === null || Number.isFinite(q1?.[k])));
  r.check("行情时间戳始终可用（提醒就靠它判这轮新不新）", true, Number.isFinite(q1?.quoteAt));
  r.check("带上了指数", true, Number.isFinite(view?.quotes?.["1.000001"]?.price));
  r.check("时段判定给了相位", true, typeof view?.session?.phase === "string" && view.session.phase.length > 0);

  // 面板这一组要在「没有冷却、失败计数也干净」的窗口里跑：
  // ① 冷却只认时间（cooldownUntil），前面行情那几条撞墙攒出的冷却没过的话，插件的 out() 会把
  //    所有请求（包括 K线/分时的）直接判在冷却里、1ms 就返回，什么都观察不到 —— 所以先等它过去。
  // ② 「连续失败」计数只被一次**成功**的请求清零；而行情每被抓一次就记一笔（add/refresh/激活都会抓），
  //    面板第一段是盘口（没有备用源、必然失败），计数带着旧账进来就会在分时/K线 换源之前先进冷却。
  //    搜索走的是同一个 out() 口子，而 searchadapter 这个域在本机是通的 —— 用真搜索清零，不伪造数据。
  const prepareFreshNetwork = async () => {
    let left = Number((await readView())?.net?.cooldownLeftSec) || 0;
    for (const until = Date.now() + 120_000; left > 0 && Date.now() < until; ) {
      await sleep(5000);
      left = Number((await readView())?.net?.cooldownLeftSec) || 0;
    }
    if (left > 0) return { cooled: false, clean: false };
    // 连着两条、中间隔 2 秒：在飞的那笔失败（重试后记账）也不会落在最后一条后面
    let clean = false;
    for (let i = 0; i < 2; i++) {
      await c.ev(`window.__seen.suggest.length = 0; window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "search", keyword: "浦发" }); true`);
      clean = await waitUntil(c, `window.__seen.suggest.length > 0`, 20_000);
      if (!clean) break;
      await sleep(2000);
    }
    return { cooled: true, clean };
  };
  const net0 = await prepareFreshNetwork();
  r.check("面板开跑前：冷却结束，且用一条真搜索把「连续失败」清零（同一口子，成功即归零）", [true, true],
    [net0.cooled, net0.clean]);
  /** 「上一次成功的源」那份记忆（插件的隔离存储里） */
  const sourceMem = async () => (await invoke("store_get", { pluginId: PID, key: "sources" })).v ?? null;
  /** 出网闸门最近 60 秒的请求数：用来分辨「这一轮撞了坏源」和「只走记住的源」 */
  const netWindow = async () => Number((await readView())?.net?.window) || 0;

  r.group("盘面：分时 / K线 / 五档（走 push2his 域名）+ 出网节制");
  const win0 = await netWindow();
  const selectAt = Date.now();
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  const gotPanel = await waitUntil(c, `window.__seen.panel.some(p => p?.depth && p?.trend && p?.kline)`, 45_000);
  const pnl = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  r.info("面板这一轮的失败明细", JSON.stringify(pnl.failed ?? null).slice(0, 300));
  r.check("选中后三段数据都到位", true, gotPanel);
  // 一次 select 要发 3 条请求（盘口/分时/K线）。闸门是 350ms 最小间隔，
  // 所以三条串起来至少要 2×350ms —— 用耗时证明请求真的过了闸门，而不是只写了个函数
  const panelMs = (pnl.at ?? 0) - selectAt;
  r.info("面板一轮三条请求耗时", `${panelMs}ms`);
  r.check("三条出网被闸门串了起来（≥2×最小间隔）", true, panelMs >= 700);
  // 序列数据体积大，必须走单独 topic；每轮的 *:widget 里不该出现它们
  const viewAfter = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (d) => { off(); res(d); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" });
      setTimeout(() => { off(); res(null); }, 8000);
    });
  })()`);
  r.check("每轮视图里没夹带分时/K线（省一次跨窗中继）", false, ["trend", "kline", "depth"].some((k) => k in (viewAfter ?? {})));
  const net = viewAfter?.net ?? {};
  r.check("视图带出了网关节流状态（界面据此解释为什么没更新）", true, Number.isFinite(net.window) && Number.isFinite(net.intervalSec));
  r.check("每分钟上限与最小间隔都下发了", true, net.perMinute === 30 && net.minGapMs === 350);
  r.check("间隔不会低于 10 秒下限，也不会超过 30 分钟退避顶", true, net.intervalSec >= 10 && net.intervalSec <= 1800);
  r.check("近 1 分钟请求数在窗口上限之内", true, net.window >= 1 && net.window <= net.perMinute);
  const grants = ((await settings.invoke("permission_list")).v ?? {})[PID] ?? [];
  r.check("新域名 push2his 也走了按域名授权", true, grants.includes("http:push2his.eastmoney.com"));
  r.check("五档买/卖各五档", [5, 5], [pnl.depth?.bids?.length, pnl.depth?.asks?.length]);
  // 竞价阶段盘口很薄，接口会给「价格 - 但量是数字」的半截档（实测 09:16 的买二）；
  // 解析层已把这种档整档判空，这里只对有价的档排序，并额外钉住「无价必无量」
  r.check("没有价格的档不带量（界面不会出现「— 配 2 手」）", true,
    [...(pnl.depth?.bids ?? []), ...(pnl.depth?.asks ?? [])].every((l) => l.price !== null || l.volume === null));
  const bidPrices = (pnl.depth?.bids ?? []).filter((l) => Number.isFinite(l.price)).map((l) => l.price);
  const askPrices = (pnl.depth?.asks ?? []).filter((l) => Number.isFinite(l.price)).map((l) => l.price);
  r.check("买价按买一→买五递减", true, bidPrices.every((p, i, a) => i === 0 || p <= a[i - 1]));
  r.check("卖价按卖一→卖五递增", true, askPrices.every((p, i, a) => i === 0 || p >= a[i - 1]));
  r.check("买一不高于卖一", true, bidPrices[0] === undefined || askPrices[0] === undefined || bidPrices[0] <= askPrices[0]);
  r.check("明细里的中文名仍是 UTF-8", "贵州茅台", pnl.depth?.name);
  r.check("涨停价是交易所给的数值且高于昨收", true, Number.isFinite(pnl.depth?.limitUp) && pnl.depth.limitUp > pnl.depth.prevClose);
  r.check("跌停价低于昨收", true, Number.isFinite(pnl.depth?.limitDown) && pnl.depth.limitDown < pnl.depth.prevClose);
  r.check("分时结构成立：数组 + 昨收基准线可用", true,
    Array.isArray(pnl.trend?.points) && Number.isFinite(pnl.trend?.preClose));
  r.check("分时有数据时形状自洽（时刻 HH:MM、价与均价都是数）", true,
    (pnl.trend?.points ?? []).every((p) => /^\d{2}:\d{2}$/.test(p.time) && Number.isFinite(p.price) && Number.isFinite(p.avg)));
  if (view?.session?.trading) {
    r.check("盘中必须拿得到分时采样点", true, (pnl.trend?.points?.length ?? 0) > 0);
  } else {
    r.info("非交易时段的分时点数", `${pnl.trend?.points?.length ?? 0}（盘前/竞价前接口可以给 0 点，图上要显示提示而不是空白）`);
  }
  r.check("K线拉满 120 根", 120, pnl.kline?.bars?.length);
  r.check("K线每根的高低价自洽", true, (pnl.kline?.bars ?? []).every((b) => b.high >= b.low && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));

  // —— 多源 failover（这一轮新加的）：东财整组在本机被连接重置，K线与分时该自动落到腾讯 ——
  const win1 = await netWindow();
  r.info("第一轮（冷记忆=东财优先）", `失败明细=${JSON.stringify(pnl.failed)} 出网增量=${win1 - win0}`);
  r.check("K线与分时都来自腾讯（冷记忆下先撞东财，失败后下移）", ["tencent", "tencent"], [pnl.klineSource, pnl.trendSource]);
  // 冷记忆这一轮要撞东财：盘口 2 次 + 分时/K线 各 2 次（传输层失败在 out() 里会重试一次），
  // 只走腾讯的话一轮 4 次左右就够 —— 这个差值就是「它真的去撞了坏源」的运行时证据
  r.check("这一轮确实去撞了坏源：出网次数 ≥6", true, win1 - win0 >= 6);
  r.check("「上一次成功的源」落盘：K线与分时都记成腾讯", { kline: "tencent", trend: "tencent" }, await sourceMem());
  // 第二轮：换一只自选（三段都重新取），记忆生效 —— 不再撞坏源，出网次数明显更少
  const at1 = Number(pnl.at ?? 0);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "0.300750" }); true`);
  const got2 = await waitUntil(c, `(() => { const p = window.__seen.panel.at(-1); return (p?.at ?? 0) > ${at1} && !!p?.kline?.bars?.length && !!p?.trend; })()`, 30_000);
  const pnl2 = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  const win2 = await netWindow();
  r.info("第二轮（记忆=腾讯）", `失败明细=${JSON.stringify(pnl2.failed)} 出网增量=${win2 - win1}`);
  r.check("第二轮照旧有数据（记忆指向的源可用，两段仍是腾讯）", [true, "tencent", "tencent"],
    [got2, pnl2.klineSource, pnl2.trendSource]);
  r.check("第二轮不再去撞坏源：出网次数比第一轮少", true, win2 - win1 < win1 - win0);
  // 把选中还给原来那只（后面的断言按它来）
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  await sleep(3000);
  const pnlBack = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "klt", value: 60 }); true`);
  const toMinute = await waitUntil(c, `window.__seen.panel.at(-1)?.klt === 60`, 20_000);
  const pnl60 = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  r.check("切到 60 分钟周期", true, toMinute);
  r.check("60 分钟线的时刻带时分", true, /\d{2}:\d{2}$/.test(pnl60.kline?.bars?.at(-1)?.time ?? ""));
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "klt", value: 101 }); true`);
  await sleep(1500);

  r.group("设置页：图真的画出来了、五档表有行");
  await settings.client.ev(`document.querySelector('#nav-plugins .nav-item[data-view=${JSON.stringify(PID)}]')?.click()`);
  const widgetReady = await waitUntil(
    settings.client,
    `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
      return !!rec?.shadow?.querySelector('canvas');
    })()`,
    20_000,
  );
  r.check("插件页挂上了画布", true, widgetReady);
  /** 从 closed shadow root 里取画布，数非背景像素 —— 「没报错」不等于「画出来了」 */
  const inkOf = () =>
    settings.client.ev(`(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
      const cv = rec?.shadow?.querySelector('canvas');
      if (!cv) return { ok: false, reason: 'no canvas' };
      const g = cv.getContext('2d');
      const px = g.getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i] - 17) > 12 || Math.abs(px[i + 1] - 19) > 12 || Math.abs(px[i + 2] - 26) > 12) ink++;
      }
      return { ok: true, ink, w: cv.width, h: cv.height, cssW: cv.clientWidth };
    })()`);
  const trendInk = await inkOf();
  r.check("分时画布按 DPR 建了位图（不是 0 尺寸）", true, trendInk.ok === true && trendInk.w >= trendInk.cssW);
  // 竞价阶段分时可能只有 1 个点（画一个点而不是折线），完全没数据时画的是提示行
  const trendPoints = pnl.trend?.points?.length ?? 0;
  const inkFloor = trendPoints > 1 ? 400 : trendPoints === 1 ? 120 : 30;
  r.info("分时笔迹像素", `${trendInk.ink} 点（分时 ${trendPoints} 个采样）`);
  r.check(
    trendPoints > 1 ? "分时图有笔迹（折线+均价+量能）" : trendPoints === 1 ? "竞价阶段单点也画得出来" : "分时为空时画的是提示行而不是空白画布",
    true,
    (trendInk.ink ?? 0) > inkFloor,
  );
  const depthRows = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const rows = [...(rec?.shadow?.querySelectorAll('table.depth tbody tr') ?? [])];
    return rows.map((r) => r.children[0]?.textContent ?? '');
  })()`);
  r.check("五档表是卖五→卖一→现价→买一→买五", 11, depthRows.length);
  r.check("档位标签顺序对", ["卖5", "卖4", "卖3", "卖2", "卖1", "现价", "买1", "买2", "买3", "买4", "买5"], depthRows);
  await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    [...rec.shadow.querySelectorAll('.tabs button')].find((b) => b.textContent === 'K线')?.click();
    return true;
  })()`);
  await sleep(400);
  const klineInk = await inkOf();
  r.check("K 线图有笔迹（蜡烛+MA+量能）", true, (klineInk.ink ?? 0) > 400);
  // 周期下拉只在 K 线页出现：这比「两张位图像素数不同」确定，不受数据形态影响
  const selVisible = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const sel = rec.shadow.querySelector('.tabs + select');
    return { on: [...rec.shadow.querySelectorAll('.tabs button')].filter((b) => b.classList.contains('on')).map((b) => b.textContent), shown: sel ? sel.offsetParent !== null : null };
  })()`);
  r.check("切到 K 线后只有 K 线页亮着", ["K线"], selVisible?.on);
  r.check("K 线页显示周期下拉", true, selVisible?.shown === true);
  const panelText = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return rec.shadow.querySelector('.panel-hd')?.textContent ?? '';
  })()`);
  r.check("面板抬头写了选中的标的与涨跌停价", true, /贵州茅台/.test(panelText) && /涨停/.test(panelText) && /分时 \d+ 点/.test(panelText));
  const selectedRow = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return [...rec.shadow.querySelectorAll('tbody tr.sel td:first-child')].map((td) => td.textContent);
  })()`);
  r.check("自选列表里高亮的是当前选中那只", true, String(selectedRow?.[0] ?? "").includes("贵州茅台"));
  const netText = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return [...rec.shadow.querySelectorAll('.muted')].map((n) => n.textContent).find((t) => /出网/.test(t)) ?? '';
  })()`);
  r.check("设置页把节流状态写给了用户（而不是默默不更新）", true, /近 1 分钟出网 \d+ 次/.test(netText));

  r.group("出网只有一个口子（grep 断言）");
  // 插件里所有出网都要过 index.js 的 out()（闸门、冷却、传输层重试都在那一处）；
  // 别处再冒出一个 ctx.http.request 调用点就等于绕开节流，AGENTS.md 明令禁止。
  const pluginDir = fileURLToPath(new URL("../plugins/com.pet.astock/", import.meta.url));
  const offenders = [];
  for (const file of readdirSync(pluginDir).filter((f) => f.endsWith(".js"))) {
    const lines = readFileSync(join(pluginDir, file), "utf8").split(/\r?\n/);
    let owner = "";
    lines.forEach((line, i) => {
      const decl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/.exec(line);
      if (decl) owner = decl[1];
      if (!line.includes("ctx.http.request")) return;
      const code = line.replace(/\/\/.*$/, "").trim();
      if (!code || code.startsWith("*") || code.startsWith("/*")) return; // 注释里提到不算调用点
      if (file === "index.js" && owner === "out") return; // 唯一许可的那一处
      offenders.push(`${file}:${i + 1}（在 ${owner || "?"} 里）`);
    });
  }
  r.check("除 index.js 的 out() 之外没有 ctx.http.request 调用点", [], offenders);
  r.check("market.js 不碰宿主 API（取数靠调用方传进来的 request）", false, /ctx\./.test(readFileSync(join(pluginDir, "market.js"), "utf8")));

  r.group("多源 failover 单测：腾讯列序与取数链（固定输入，不依赖跑测时是否开盘）");
  /**
   * 固定输入，来自 2026-10-09 那几次真实返回：
   *   K线：除权那一行（7 列，末尾多一个分红对象）与 09-16/09-17/10-09 三行都是原样抄的，
   *        其中 09-17 那条就是任务书里给出的样例。
   *   分时：首条与末条原样抄；15:00 那行用的是同一天快照交叉验证过的累计量/额
   *        （947958 手 / 915309833 元），15:06 那行按同一次返回的形状补 —— 都是固定输入。
   */
  const KLINE_DAY = {
    code: 0,
    msg: "",
    data: {
      sh600000: {
        qfqday: [
          ["2026-07-16", "8.920", "8.850", "8.940", "8.800", "755826.000", { nd: "2025", fh_sh: "4.2" }],
          ["2026-09-16", "9.170", "9.100", "9.200", "9.000", "723404.000"],
          ["2026-09-17", "9.100", "9.060", "9.140", "9.030", "456711.000"],
          ["2026-10-09", "9.70", "9.54", "9.74", "9.54", "947958"],
        ],
        // qt 段：实测下标 4 是昨收。这里只留前 9 段（后面几十段与解析无关，截断不改变语义）
        qt: { sh600000: ["1", "浦发银行", "600000", "9.54", "9.70", "9.70", "947958", "449628", "498330"] },
        // prec 实测 9.510，与昨收 9.70 不是一回事：留着它就是钉住「解析没去读 prec」
        prec: "9.510",
        version: "18",
      },
    },
  };
  const dayBars = parseTencentKline(KLINE_DAY, { code: "sh600000", period: "day", count: 120 }).bars;
  r.check("腾讯日K 逐字段相等（日期/开/收/高/低/量；除权行只认前 6 列）", [
    ["2026-07-16", 8.92, 8.85, 8.94, 8.8, 755826],
    ["2026-09-16", 9.17, 9.1, 9.2, 9.0, 723404],
    ["2026-09-17", 9.1, 9.06, 9.14, 9.03, 456711],
    ["2026-10-09", 9.7, 9.54, 9.74, 9.54, 947958],
  ], dayBars.map((b) => [b.time, b.open, b.close, b.high, b.low, b.volume]));
  r.check("列序是「开收高低」而不是「开高低收」（高≥低且高≥开收，逐根成立）", true,
    dayBars.every((b) => b.high >= b.low && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));
  r.check("请求 2 根时从尾部对齐（实测腾讯会多回一根）", ["2026-09-17", "2026-10-09"],
    parseTencentKline(KLINE_DAY, { code: "sh600000", period: "day", count: 2 }).bars.map((b) => b.time));
  r.check("昨收取 qt 第 5 段 9.70，不是同级的 prec 9.510", 9.7, parseTencentKline(KLINE_DAY, { code: "sh600000" }).preKPrice);
  const weekBar = parseTencentKline(
    { data: { sh600000: { qfqweek: [["2026-10-09", "9.450", "9.54", "9.74", "9.410", "2098227"]] } } },
    { code: "sh600000", period: "week" },
  ).bars[0];
  r.check("周线走 qfqweek（周期是参数，不硬编 day）", ["2026-10-09", 9.45, 9.54, 9.74, 9.41, 2098227],
    [weekBar.time, weekBar.open, weekBar.close, weekBar.high, weekBar.low, weekBar.volume]);
  r.check("代码前缀：沪 sh / 深 sz / 北交所 bj（920185 实测在 bj 那一边）", ["sh600000", "sz300750", "bj920185", null],
    ["1.600000", "0.300750", "0.920185", "bad"].map(tencentCodeOf));

  const MINUTE_ROWS = [
    "0930 9.70 4256 4128320.00",
    "0931 9.70 26626 25842111.83",
    "1130 9.67 498172 482689839.39",
    "1300 9.67 498172 482689839.39",
    "1500 9.54 947958 915309833.00",
    "1506 9.54 948000 915400000.00",
    "1530 9.54 948106 915450551.88",
  ];
  const MINUTE = {
    data: {
      sh600000: {
        data: { date: "20261009", data: MINUTE_ROWS },
        qt: { sh600000: ["1", "浦发银行", "600000", "9.54", "9.70", "9.70", "947958"] },
      },
    },
  };
  const rawMinute = parseTencentMinuteRows(MINUTE_ROWS);
  r.check("分时首/末条逐字段（时刻 HH:MM、价、累计量、累计额）",
    [["09:30", 9.7, 4256, 4128320], ["15:30", 9.54, 948106, 915450551.88]],
    [rawMinute[0], rawMinute.at(-1)].map((r) => [r.time, r.price, r.cumVolume, r.cumAmount]));
  // 「第 3、4 列是累计而不是当分钟增量」由这条钉住：同一次返回里整条单调不减
  r.check("第 3、4 列单调不减（累计量 / 累计额）", true,
    rawMinute.every((r, i) => i === 0 || (r.cumVolume >= rawMinute[i - 1].cumVolume && r.cumAmount >= rawMinute[i - 1].cumAmount)));
  const minuteTrend = parseTencentTrend(MINUTE, { code: "sh600000" });
  r.check("只留连续竞价时段（15:06–15:30 的盘后行不进 242 槽的轴）", ["09:30", "09:31", "11:30", "13:00", "15:00"],
    minuteTrend.points.map((p) => p.time));
  r.check("分时的昨收同样取自 qt 第 5 段（图上的平盘基准线）", 9.7, minuteTrend.preClose);
  // 容差 1e-9（相对）：解析里就是这条算式，容差只给浮点留余量，不是「差不多就行」
  r.check("均价 = 累计额 ÷ (累计量 × 100)", true,
    minuteTrend.points.every((p) => Math.abs(p.avg - p.cumAmount / (p.cumVolume * 100)) <= 1e-9 * Math.abs(p.avg)));
  r.check("末点均价落在实测值上（915309833 ÷ (947958×100) ≈ 9.656）", true,
    Math.abs(minuteTrend.points.at(-1).avg - 9.656) < 0.001);
  r.check("量能柱用当分钟量（累计量差分；首根是集合竞价的量，午休两点差 0）", [4256, 22370, 471546, 0, 449786],
    minuteTrend.points.map((p) => p.volume));
  const bjTrend = parseTencentTrend({ data: { bj920185: { data: { data: ["0930 21.01 189", "0931 21.01 300"] } } } }, { code: "bj920185" });
  r.check("北交所那种只有 3 列的响应：量照解，均价留空而不是瞎算", [null, null], bjTrend.points.map((p) => p.avg));
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  r.check("数组缺失 / 行全解不出都判源失败（不许静默画错图）", [true, true], [
    throws(() => parseTencentTrend({ data: { sh600000: {} } }, { code: "sh600000" })),
    throws(() => parseTencentTrend({ data: { sh600000: { data: { data: ["这不是分时行"] } } } }, { code: "sh600000" })),
  ]);

  // 取数链本身也用假 request 钉一遍（确定、不碰网络）：东财抛错 → 腾讯；记住的源优先
  const fakeNet = () => {
    const seen = [];
    return {
      seen,
      request: async (url) => {
        const host = new URL(url).hostname;
        seen.push(host);
        if (host.endsWith("eastmoney.com")) throw new Error(`fetch failed: 注入的连接重置 https://${host}/x`);
        return { status: 200, body: JSON.stringify(url.includes("fqkline") ? KLINE_DAY : MINUTE) };
      },
    };
  };
  const netA = fakeNet();
  const chainA = await fetchKline(netA.request, "1.600000", 101);
  r.check("东财那条失败后，K线落到腾讯并真的解出数据", ["tencent", 4], [chainA.source, chainA.data.bars.length]);
  const netB = fakeNet();
  const chainB = await fetchKline(netB.request, "1.600000", 101, { preferred: "tencent" });
  r.check("记住的源优先：这一轮一次都没撞东财", [["proxy.finance.qq.com"], "tencent"], [netB.seen, chainB.source]);
  const netC = fakeNet();
  const chainC = await fetchTrend(netC.request, "1.600000");
  r.check("东财那条失败后，分时同样落到腾讯并解出数据", ["push2his.eastmoney.com", "proxy.finance.qq.com", "tencent", 5],
    [...netC.seen, chainC.source, chainC.data.points.length]);
  let aggErr = null;
  try {
    await fetchTrend(async (url) => {
      throw new Error(`fetch failed: ${new URL(url).hostname} 不通`);
    }, "1.600000");
  } catch (err) {
    aggErr = err;
  }
  // message 是给界面的一行（含两个源名），detail 是给日志的（每个源一条，里面带着各自的入口）
  r.check("全部源都失败：错误里点出每个源与每个入口（含两个备用入口）", true,
    /东方财富/.test(aggErr?.message ?? "") &&
      ["push2his.eastmoney.com", "proxy.finance.qq.com", "web.ifzq.gtimg.cn", "ifzq.gtimg.cn"].every((host) =>
        String(aggErr?.message ?? "").includes(host),
      ) &&
      (aggErr?.detail?.length ?? 0) === 2);

  r.group("多源 failover 运行时：没有源能供这个周期时的界面 + 记忆读回");
  // ⑥ 没有任何源能供这个周期（腾讯只供日K，东财整组在本机不可达）：错误行要出来，
  //    且不能拿上一轮的旧 K 线当新周期的结果发出去 —— 切周期最容易出这种「错周期的图」。
  r.check("切周期前手里有一份非空的 K 线（下面那条才不是空转）", true, !!pnlBack?.kline?.bars?.length);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "klt", value: 60 }); true`);
  const got60 = await waitUntil(c, `(() => { const p = window.__seen.panel.at(-1); return p?.klt === 60 && !!p?.failed?.kline; })()`, 30_000);
  const p60 = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  r.info("60 分钟那轮的失败明细", String(p60.failed?.kline));
  if (p60.kline?.bars?.length) {
    // 东财可达时它会直接供 60 分钟线，这一组的前提（东财整组不可达）就不成立了
    r.info("东财在本机可达：60 分钟线直接拿到了数据，下面两条断言在当前网络下不适用", `源=${p60.klineSource}`);
  } else {
    r.check("东财不可达 + 腾讯不供 60 分钟：给出错误行并摘掉 K 线（不画错周期的图）", [true, null], [got60, p60.kline]);
    r.check("上一轮那份非空 K 线没有被当成本轮结果发布（摘成 null）", true,
      !!pnlBack?.kline?.bars?.length && p60.kline === null);
    r.check("错误里写清谁不行（东方财富 + 腾讯）", true,
      /东方财富/.test(String(p60.failed?.kline)) && /腾讯/.test(String(p60.failed?.kline)));
  }
  const errShown = await waitUntil(settings.client, `(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const nodes = [...(rec?.shadow?.querySelectorAll('.chart-col .muted') ?? [])];
    return nodes.some((n) => /盘面数据拉取失败/.test(n.textContent));
  })()`, 15_000);
  r.check("插件页上是错误行而不是空白", true, errShown);

  // ② 记忆是从 storage 读回来的：改成东财再重启插件，重启后第一轮就该先试东财
  await invoke("store_set", { pluginId: PID, key: "sources", value: { kline: "eastmoney", trend: "eastmoney" } });
  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.deactivatePlugin(${JSON.stringify(PID)});
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PID)}));
    return true;
  })()`);
  await sleep(1500);
  r.check("重启后插件活着", true,
    await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`));
  r.check("重启读回的记忆是东财（storage 里那份，不是内存里的残留）", "eastmoney", (await readView())?.net?.sources?.kline);
  // 收尾：切回日K，把选中的标的还给原来那只（重启会把它清掉），后面的断言按它来
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "klt", value: 101 }); true`);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  await sleep(2000);
  r.check("收尾：选中的标的回到 1.600519（下面「删除后盘面收掉」按它来）", "1.600519",
    await c.ev(`window.__seen.panel.at(-1)?.secid ?? null`));

  r.group("阈值规则保存与回显");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "update", secid: "1.600519", upper: 1, lower: 99999, pct: 3 })}); true`);
  await sleep(1500);
  const withRules = (await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? [];
  const item = withRules.find((w) => w.secid === "1.600519");
  r.check("三个阈值都存下", [1, 99999, 3], [item?.upper, item?.lower, item?.pct]);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "update", secid: "1.600519", upper: "" })}); true`);
  await sleep(1500);
  const cleared = ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).find((w) => w.secid === "1.600519");
  r.check("清空一个阈值不影响另外两个", [null, 99999, 3], [cleared?.upper, cleared?.lower, cleared?.pct]);

  r.group("配置：间隔下限与模式");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { intervalSec: 1, mode: "overlay" } })}); true`);
  await sleep(1500);
  const cfg = (await invoke("store_get", { pluginId: PID, key: "config" })).v ?? {};
  r.check("间隔被夹到下限 10s（不给压公共接口）", 10, cfg.intervalSec);
  r.check("模式已切到 overlay", "overlay", cfg.mode);
  r.check(
    "左上角盯盘卡可见",
    true,
    await waitUntil(
      c,
      `(async () => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-com_pet_astock' })) === true)()`,
      15_000,
    ),
  );
  const cardTarget = (await listPages(PORT)).find(
    (t) => /overlay\.html/.test(t.url) && t.title === `DesktopPet Overlay · ${PID}`,
  );
  r.check("卡片页按标题能被认出来", true, !!cardTarget);
  let oc = null;
  if (cardTarget) {
    oc = await attach(PORT, (t) => t.webSocketDebuggerUrl === cardTarget.webSocketDebuggerUrl, 10_000);
    r.check(
      "盯盘卡里挂上了本插件的 overlay widget",
      true,
      await oc.ev(`!!document.querySelector('#widget-overlay div[data-plugin-id=${JSON.stringify(PID)}]')`),
    );
  }

  r.group("提醒链路（通知 + 宠物反应）");
  await c.ev(`(async () => {
    const host = await import('/src/pet/host.ts');
    const ctrl = host.petController();
    window.__pet = { acts: [], said: [] };
    const react0 = ctrl.react.bind(ctrl), say0 = ctrl.say.bind(ctrl);
    ctrl.react = (a) => { window.__pet.acts.push(a); return react0(a); };
    ctrl.say = (t) => { window.__pet.said.push(t); return say0(t); };
    return true;
  })()`);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "testAlert" }); true`);
  const alerted = await waitUntil(c, `window.__seen.alert.length > 0`, 15_000);
  r.check("提醒广播到了总线", true, alerted);
  r.check("宠物有反应", true, (await c.ev(`window.__pet.acts.length`)) > 0);
  r.check("宠物说了台词", true, (await c.ev(`window.__pet.said.some(t => /测试/.test(t))`)));
  const recent = (await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (d) => { off(); res(d.recent ?? []); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" });
      setTimeout(() => { off(); res([]); }, 8000);
    });
  })()`));
  r.check("最近提醒进了视图", true, recent.some((a) => /测试/.test(a.message ?? "")));

  r.group("配置改动不会把另一项抹成默认（回显）");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { petOn: false } })}); true`);
  await sleep(1500);
  const cfg2 = (await invoke("store_get", { pluginId: PID, key: "config" })).v ?? {};
  r.check("只改 petOn，间隔与模式保持", [10, "overlay"], [cfg2.intervalSec, cfg2.mode]);
  r.check("petOn 确实关了", false, cfg2.petOn);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { petOn: true } })}); true`);
  await sleep(800);

  r.group("删除与停用后的回收");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "remove", secid: "0.300750" })}); true`);
  await sleep(1500);
  r.check("删掉一只", ["1.600519"], ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).map((w) => w.secid));
  // 正开着盘面的那只被删掉时，面板要收掉，不能继续画它的曲线
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "remove", secid: "1.600519" }); true`);
  const panelCleared = await waitUntil(c, `window.__seen.panel.at(-1)?.cleared === true`, 15_000);
  r.check("删掉选中标的后盘面收掉", true, panelCleared);
  await c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); await rt.deactivatePlugin(${JSON.stringify(PID)}); return true; })()`);
  await sleep(1500);
  r.check("停用后插件确实不在活动列表", false, await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`));
  const cardGone = await waitUntil(
    c,
    `(async () => {
      try { const v = await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-com_pet_astock' }); return v !== true; }
      catch { return true; } // 窗口记录都没了，当然是收掉了
    })()`,
    12_000,
  ).catch(() => false);
  if (!cardGone) {
    // 失败要能说清是哪一类：还在活动列表里被 watcher 重新激活了，还是 destroy 真的没落地
    r.info("卡仍可见时的现场", JSON.stringify({
      active: await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`),
      enabled: await c.ev(`localStorage.getItem('host:enabled-plugins')`),
      mode: ((await invoke("store_get", { pluginId: PID, key: "config" })).v ?? {}).mode,
      windows: (await listPages(PORT)).filter((t) => /overlay\.html/.test(t.url)).map((t) => t.title),
    }));
  }
  r.check("停用后卡收掉", true, cardGone);
  r.check(
    "停用后指令 topic 没有残留订阅（宿主回收）",
    true,
    await c.ev(`(async () => { const { bus } = await import('/src/runtime/event-bus.ts'); return (bus.handlers.get(${JSON.stringify(`${PID}:cmd`)})?.size ?? 0) === 0; })()`),
  );
  oc?.close();
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  stopped = true;
  if (c) {
    // 下线 + 撤销授权（连带清掉它的存储），最后换新文档
    await c
      .ev(`(async () => {
        const rt = await import('/src/runtime/plugin-runtime.ts');
        rt.setEnabledIds(JSON.parse(${JSON.stringify(origEnabled)}));
        await rt.deactivatePlugin(${JSON.stringify(PID)});
        return true;
      })()`)
      .catch(() => undefined);
    if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
    if (settings) await settings.invoke("permission_revoke", { pluginId: PID }).catch(() => undefined);
    settings?.close();
    settings = null;
    await sleep(1500);
    await reloadAndWait(c).catch(() => undefined);
    await sleep(1200);
  } else {
    settings?.close();
  }
  const failed = r.summary();
  c?.close();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
