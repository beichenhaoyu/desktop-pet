// 隔离与安全回归断言。连到「已在运行」的 dev 实例，跑完给非零退出码即失败。
//   终端 1: npm run dev:debug     终端 2: npm run verify
// 只覆盖 dev 能验证的部分；CSP 与打包路径见 verify-release.mjs（每波次收尾手工跑一次）。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";
import { PROBE_ID, SPOOF_DIR, removeFixtures, writeFixtures } from "./fixtures.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PLUGINS_DIR = resolve(import.meta.dirname, "../plugins");
// store.rs 落在 app_data_dir()/plugins/<id>/；Windows 上 app_data_dir = %APPDATA%/<identifier>
const STORE_DIR = join(env.APPDATA ?? "", "com.desktoppet.pet", "plugins", PROBE_ID);
const probeManifest = (permissions) =>
  `{ id: ${JSON.stringify(PROBE_ID)}, widget: 'widget.js', permissions: ${JSON.stringify(permissions)} }`;
const MOUNT_BARE = `window.__wh.mount(${probeManifest([])}, 'badge')`;
const MOUNT_CAPPED = `window.__wh.mount(${probeManifest(["bus:publish", "bus:subscribe"])}, 'settings', document.body)`;
const r = createReport("隔离与安全回归（dev）");
const invoke = (c) => hostInvoke(c);

const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

// 往 plugins/ 写 fixture 会让 Vite 触发一次整页重载，所以先写完再连；
// 装上的宿主句柄仍可能被随后的重载冲掉，故下面的安装带退避重试。
let c;
let aborted = false;
try {
  writeFixtures(PLUGINS_DIR);
  await sleep(2500);
  c = await attach(PORT, isPetPage);
  r.info("已连接", c.url);
  const INSTALL = `(async () => {
    if (!window.__wh || !Array.isArray(window.__canary)) {
      const { bus } = await import('/src/runtime/event-bus.ts');
      window.__canary = [];
      bus.subscribe('ble:heart-rate', (p) => window.__canary.push(p));
      window.__wh = (await import('/src/runtime/widget-host.ts')).widgetHost;
      window.__probes = [];
    }
    return typeof window.__wh?.mount === 'function' && Array.isArray(window.__canary);
  })()`;
  let ready = false;
  for (let i = 0; i < 8 && !ready; i++) {
    ready = await c.ev(INSTALL).catch(() => false);
    if (!ready) await sleep(2000);
  }
  r.check("widgetHost 与真实总线可达", true, ready);
  if (!ready) throw new Error("拿不到宿主的 widgetHost/总线单例（页面持续重载？）");

  // 起点必须自己清干净：Vite 已不 watch plugins/，页面不会因 fixture 写入而重载，
  // 上一轮（尤其是崩溃的那轮）遗留的挂载会抑制本轮 mount，看起来像「探针没执行」
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  await c.ev(`window.__probes = []; window.__canary = []`);

  // 页面若在测试中途重载（编辑触发的 HMR、崩溃），window 上的句柄与计数会凭空消失，
  // 表现为看不懂的 TypeError。这里埋一个世代标记，越界时给出可执行的提示。
  const TOKEN = `verify-${Date.now()}`;
  await c.ev(`window.__verifyToken = ${JSON.stringify(TOKEN)}`);
  const guard = async () => {
    if (!(await c.ev(`window.__verifyToken === ${JSON.stringify(TOKEN)}`))) {
      throw new Error("页面在测试期间发生了重载（多为 HMR 触发），本次结果不可信 —— 重跑 npm run verify");
    }
  };

  const invoke_ = invoke(c);
  const listed = await invoke_("plugins_list");
  r.check("宿主能列出探针插件", true, (listed.v ?? []).some((m) => m.id === PROBE_ID));

  await guard();
  r.group("零权限插件（manifest.permissions = []）的越权尝试");
  await c.ev(MOUNT_BARE);
  const bare = await c.ev(`window.__probes[0]`);
  if (!bare) throw new Error("探针 widget 未执行 mount()");
  r.check("发布自己 topic 需声明 bus:publish", "BLOCKED", bare.attempts.publish_own);
  r.check("发布他人 topic", "BLOCKED", bare.attempts.publish_foreign);
  r.check("发布宿主 topic", "BLOCKED", bare.attempts.publish_host);
  r.check("通配发布", "BLOCKED", bare.attempts.publish_wildcard);
  r.check("订阅自己命名空间放行", "THROUGH", bare.attempts.subscribe_own);
  r.check("订阅自己命名空间通配放行", "THROUGH", bare.attempts.subscribe_own_wildcard);
  r.check("未声明 bus:subscribe 时订阅宿主 topic", "BLOCKED", bare.attempts.subscribe_host);
  r.check("全通配订阅 *", "BLOCKED", bare.attempts.subscribe_all_wildcard);
  r.check("通配订阅他人命名空间", "BLOCKED", bare.attempts.subscribe_foreign_wildcard);
  r.check("bus 视图只暴露 publish/subscribe", ["publish", "subscribe"], bare.busKeys);
  r.check("拿不到 inject", false, bare.hasInject);
  r.check("拿不到 handlers", false, bare.hasHandlers);

  r.group("正向对照：声明了能力就该放行（证明上面的拦不是无条件抛错）");
  await c.ev(MOUNT_CAPPED);
  const capped = await c.ev(`window.__probes[1]`);
  r.check("声明后发布自己 topic 放行", "THROUGH", capped?.attempts?.publish_own);
  r.check("声明后订阅宿主 topic 放行", "THROUGH", capped?.attempts?.subscribe_host);
  r.check("声明后仍不得发布他人 topic", "BLOCKED", capped?.attempts?.publish_foreign);

  r.group("被拦的发布不得漏给真实订阅者");
  r.check("金丝雀没收到伪造的 ble:heart-rate", 0, await c.ev(`window.__canary.length`));

  await guard();
  r.group("widget 挂载生命周期");
  const sel = `#widget-badge > div[data-plugin-id="${PROBE_ID}"]`;
  r.check("badge 容器已挂载", 1, await c.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`));
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  r.check("卸载后容器移除", 0, await c.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`));
  r.check("卸载后 has() 为假", false, await c.ev(`window.__wh.has(${JSON.stringify(PROBE_ID)})`));

  r.group("并发重复挂载竞态");
  const twice = await Promise.all([
    c.ev(MOUNT_BARE),
    c.ev(MOUNT_BARE),
  ]);
  void twice;
  r.check("同时两次 mount 只留一个容器", 1, await c.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`));
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);

  r.group("宿主侧规则（直打 invoke，绕过 JS 能力桥）");
  const undeclared = await invoke_("permission_request", {
    pluginId: "com.pet.hr-ble",
    pluginName: "心率蓝牙",
    capabilities: ["camera:record"],
  });
  r.check("未声明能力被拒", true, !undeclared.ok && /未在 manifest 声明/.test(String(undeclared.e)));
  const spoofAnswer = await invoke_("consent_answer", { reqId: "rNOPE", granted: true });
  r.check("非同意框窗口不能应答授权", true, !spoofAnswer.ok && /does not own/.test(String(spoofAnswer.e)));
  const spoofDetails = await invoke_("consent_details", { reqId: "rNOPE" });
  r.check("非同意框窗口不能读授权详情", true, !spoofDetails.ok && /does not own/.test(String(spoofDetails.e)));

  const ids = (await invoke_("plugins_list")).v?.map((m) => m.id) ?? [];
  r.check("冒名目录的 id 未被列入", false, ids.includes(SPOOF_DIR));
  r.check("id 无重复（冒名者未顶替合法插件）", ids.length, new Set(ids).size);

  // 上面都是测试主动 mount；这一组让宿主在页面加载时自己去 import 入口与 widget，
  // 覆盖 activatePlugin 那条 import（petplugin 协议的真实使用方）
  r.group("宿主自身激活路径");
  const prevEnabled = await c.ev(`localStorage.getItem('host:enabled-plugins') ?? '[]'`);
  await c.ev(`localStorage.setItem('host:enabled-plugins', JSON.stringify([${JSON.stringify(PROBE_ID)}]))`);
  await reloadAndWait(c);
  const badgeSelector = `#widget-badge > div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
  const mountedByHost = await waitUntil(c, `!!document.querySelector(${JSON.stringify(badgeSelector)})`);
  if (!mountedByHost) {
    // 失败时把现场打出来，否则只能看到一句 false
    console.log(
      "     现场: activated=" +
        (await c.ev(`window.__probeActivated ?? 'none'`)) +
        " 选择器再查一次=" +
        (await c.ev(`!!document.querySelector(${JSON.stringify(badgeSelector)})`)) +
        " 命中数=" +
        (await c.ev(`document.querySelectorAll('div[data-plugin-id]').length`)) +
        " 全部 id=" +
        JSON.stringify(await c.ev(`[...document.querySelectorAll('div[data-plugin-id]')].map(d=>d.dataset.pluginId+':'+d.dataset.region)`)) +
        " enabled=" +
        JSON.stringify(await c.ev(`localStorage.getItem('host:enabled-plugins')`)),
    );
  }
  r.check("探针 widget 由宿主挂载成功", true, mountedByHost);
  r.check("入口 index.js 的 activate() 被调用", true, await c.ev(`(window.__probeActivated ?? 0) >= 1`));
  r.group("热安装 / 热移除（不重启宿主，仅靠 plugins 目录 watcher）");
  // 先造出「有启用记录但目录不存在」的状态：此时不该有任何激活
  removeFixtures(PLUGINS_DIR);
  await c.ev(`localStorage.setItem('host:enabled-plugins', JSON.stringify([${JSON.stringify(PROBE_ID)}]))`);
  await reloadAndWait(c);
  // 哨兵：整段测试期间页面一旦被重载，下面的结论就都不成立
  await c.ev(`window.__hotSentinel = "armed"`);
  r.check("仅有启用记录、目录缺失时不激活", false, await c.ev(`(window.__probeActivated ?? 0) >= 1`));
  writeFixtures(PLUGINS_DIR);
  r.check("放入目录后免重启即激活", true, await waitUntil(c, `(window.__probeActivated ?? 0) >= 1`, 20_000));
  r.check("widget 容器随之出现", true, await c.ev(`!!document.querySelector('div[data-plugin-id=${JSON.stringify(PROBE_ID)}]')`));
  r.check("期间页面未重载（激活确实来自 watcher）", "armed", await c.ev(`window.__hotSentinel ?? '页面被重载了'`));
  removeFixtures(PLUGINS_DIR);
  r.check("移走目录后自动 deactivate", true, await waitUntil(c, `(window.__probeDeactivated ?? 0) >= 1`, 20_000));
  r.check("widget 容器随之移除", 0, await c.ev(`document.querySelectorAll('div[data-plugin-id=${JSON.stringify(PROBE_ID)}]').length`));

  r.group("撤销授权连带清理插件存储");
  await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: { mode: "badge" } });
  const readBack = () =>
    c.ev(
      `(async()=>{ const v = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE_ID)}, key: 'prefs' }); return v?.mode ?? null; })()`,
    );
  r.check("写入可读回", "badge", await readBack());
  r.check("宿主的落盘目录已建", true, existsSync(STORE_DIR));
  await invoke_("permission_revoke", { pluginId: PROBE_ID });
  r.check("撤销后存储读不到旧值", null, await readBack());
  r.check("落盘目录随之删除", false, existsSync(STORE_DIR));

  await c.ev(`localStorage.setItem('host:enabled-plugins', ${JSON.stringify(prevEnabled)})`);
  await reloadAndWait(c);

  r.group("dev 下的 CSP 现状（仅作基线记录，断言在 verify-release.mjs）");
  r.info("探针内 eval", bare.csp);
  r.check("widget 注入 <style> 生效", true, bare.styleApplied);

  r.group("宿主页面自身未产生 CSP 违规或未捕获异常");
  r.check("无", 0, c.noise.length);
  if (c.noise.length) c.noise.forEach((n) => console.log("   " + n));
} catch (err) {
  // 断言中途抛错时别只丢一个栈：给出可读原因
  aborted = true;
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  removeFixtures(PLUGINS_DIR);
  c?.close();
  // 等 websocket 真正关掉再退出，否则 Windows 上 Node 会在 stderr 抛一句 libuv 断言
  await new Promise((res) => setTimeout(res, 300));
}

process.exit(aborted || r.summary() ? 1 : 0);
