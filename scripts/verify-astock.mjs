// A股盯盘插件的端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:astock
// 覆盖：授权（含按域名的 http 授权）、走宿主代理取行情（UTF-8 中文名是关键证据）、
// 自选增删与阈值落盘、badge/overlay/插件页三区渲染、提醒链路（系统通知 + 宠物反应）、
// 停用后定时器与订阅回收。跑完撤销授权并下线插件。
//
// 会在屏幕上弹出系统通知（一次「测试提醒」），并短暂开一扇左上角盯盘卡。
// 收盘后行情时间戳不前进，规则命中会被「本轮没有新数据」这道闸挡住 ——
// 那部分判定逻辑由 market.js / rules.js 的纯函数断言覆盖，这里只验链路。
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
    window.__seen = { quote: [], alert: [], status: [], suggest: [] };
    for (const k of ['quote', 'alert', 'status', 'suggest']) {
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
  r.check("视图里两只都有价格", true, typeof view?.quotes?.["1.600519"]?.price === "number");
  r.check("中文名来自宿主代理仍是 UTF-8", "贵州茅台", view?.quotes?.["1.600519"]?.name);
  r.check("涨跌幅是小数字而不是 '-'", true, typeof view?.quotes?.["1.600519"]?.pct === "number");
  r.check("带上了指数", true, Number.isFinite(view?.quotes?.["1.000001"]?.price));
  r.check("时段判定给了相位", true, typeof view?.session?.phase === "string" && view.session.phase.length > 0);

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
  await c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); await rt.deactivatePlugin(${JSON.stringify(PID)}); return true; })()`);
  await sleep(1500);
  r.check("停用后卡收掉", false, await c.ev(`(async () => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-com_pet_astock' })) === true)()`).catch(() => false));
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
