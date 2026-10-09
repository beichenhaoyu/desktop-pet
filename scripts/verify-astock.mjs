// A股盯盘插件的端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:astock
// 覆盖：授权（含按域名的 http 授权）、走宿主代理取行情（UTF-8 中文名是关键证据）、
// 自选增删与阈值落盘、badge/overlay/插件页三区渲染、选中个股的分时/K线/五档（含画布真的画出像素）、
// 提醒链路（系统通知 + 宠物反应）、停用后定时器与订阅回收。跑完撤销授权并下线插件。
//
// 会在屏幕上弹出系统通知（一次「测试提醒」），并短暂开一扇左上角盯盘卡、把设置页点到插件页。
// 收盘后行情时间戳不前进，规则命中会被「本轮没有新数据」这道闸挡住 ——
// 那部分判定逻辑由 market.js / rules.js 的纯函数断言覆盖，这里只验链路。
// 分时/K线/五档取的是接口最近一次的数据，所以休市跑也断言得出结构，只有提醒那条要看时段。
import { argv, env } from "node:process";
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

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PID = "com.pet.astock";
const ENABLED_KEY = "host:enabled-plugins";
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("A股盯盘插件（dev）");

let stopped = false;
/** 同意框按能力分批弹，必须整轮持续点「允许」；域名授权也是走同一个框 */
async function pump(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (!stopped && Date.now() < until) {
    const target = (await listPages(PORT).catch(() => [])).find((t) => /consent/.test(t.url));
    if (!target) {
      await sleep(250);
      continue;
    }
    try {
      const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
      try {
        await cs.ev(`document.getElementById('btn-allow').click()`);
      } finally {
        cs.close();
      }
    } catch (e) {
      console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
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
  void pump(300_000);

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
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "search", keyword: "茅台" }); true`);
  const gotSug = await waitUntil(c, `window.__seen.suggest.length > 0`, 40_000);
  r.check("按名称搜索有回音（http 授权已放行）", true, gotSug);
  const sugRows = (await c.ev(`window.__seen.suggest.at(-1)?.rows ?? []`)) ?? [];
  r.check("搜到 600519 且中文名没乱码", true, sugRows.some((s) => s.code === "600519" && /贵州茅台/.test(s.name ?? "")));

  r.group("加自选与行情");
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
  r.check("取不到的数值落成 null，不漏出 undefined 或字符串 '-'", true,
    ["price", "pct", "change", "prevClose", "volume"].every((k) => q1?.[k] === null || Number.isFinite(q1[k])));
  r.check("行情时间戳始终可用（提醒就靠它判这轮新不新）", true, Number.isFinite(q1?.quoteAt));
  r.check("带上了指数", true, Number.isFinite(view?.quotes?.["1.000001"]?.price));
  r.check("时段判定给了相位", true, typeof view?.session?.phase === "string" && view.session.phase.length > 0);

  r.group("盘面：分时 / K线 / 五档（走 push2his 域名）+ 出网节制");
  const selectAt = Date.now();
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  const gotPanel = await waitUntil(c, `window.__seen.panel.some(p => p?.depth && p?.trend && p?.kline)`, 45_000);
  const pnl = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
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
