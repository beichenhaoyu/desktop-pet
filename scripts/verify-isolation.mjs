// 隔离与安全回归断言。连到「已在运行」的 dev 实例，跑完给非零退出码即失败。
//   终端 1: npm run dev:debug     终端 2: npm run verify
// 只覆盖 dev 能验证的部分；CSP 与打包路径见 verify-release.mjs（每波次收尾手工跑一次）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";
import { NET_ID, PROBE_ID, SPOOF_DIR, removeFixtures, writeFixtures } from "./fixtures.mjs";

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

/**
 * 等同意框弹出、读它展示了什么，然后按 how 作答。
 * close 必须走真实关窗路径（plugin:window|close 才会触发 Rust 的 CloseRequested；
 * CDP 的 Page.close 绕过它），且不能 await 其响应 —— 关闭会先拆掉发起调用的 webview。
 */
async function driveConsent(how) {
  const target = await waitForPage(PORT, (t) => /consent/.test(t.url), 15_000);
  const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 10_000);
  try {
    const seen = {
      caps: await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`),
      name: await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`),
      label: await cs.ev(`window.__TAURI_INTERNALS__.metadata.currentWindow.label`),
    };
    if (how === "allow") {
      await cs.ev(`document.getElementById('btn-allow').click()`);
    } else {
      await cs.ev(
        `(() => { window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: ${JSON.stringify(seen.label)} }); return true; })()`,
      );
    }
    return seen;
  } finally {
    cs.close();
  }
}

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

  // 上一轮崩溃可能把探针留在启用清单里：目录 watcher 会据此自动激活它，
  // 于是测试自己看到的 badge 里多出别人（宿主）挂的容器。起点钉死清单。
  const baselineEnabled = await c.ev(`(() => {
    const key = 'host:enabled-plugins';
    const prev = JSON.parse(localStorage.getItem(key) ?? '[]');
    const clean = Array.isArray(prev) ? prev.filter((id) => id !== ${JSON.stringify(PROBE_ID)} && id !== ${JSON.stringify(NET_ID)}) : [];
    localStorage.setItem(key, JSON.stringify(clean));
    return JSON.stringify(prev);
  })()`);

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
  // 用增量而不是绝对计数：宿主自己也可能挂过同名容器，绝对数在共享 DOM 上不可靠
  const sel = `#widget-badge > div[data-plugin-id="${PROBE_ID}"]`;
  const badgeCount = () => c.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  const base = await badgeCount();
  await c.ev(MOUNT_BARE);
  r.check("mount 后容器 +1", base + 1, await badgeCount());
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  r.check("卸载后回到基线", base, await badgeCount());
  r.check("卸载后 has() 为假", false, await c.ev(`window.__wh.has(${JSON.stringify(PROBE_ID)})`));

  r.group("并发重复挂载竞态");
  const base2 = await badgeCount();
  await Promise.all([c.ev(MOUNT_BARE), c.ev(MOUNT_BARE)]);
  r.check("同时两次 mount 只 +1", base2 + 1, await badgeCount());
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

  r.group("总线自递归必须被深度上限截断");
  // 嵌套调用走 inject 而不是 publish：两者共用同一个 dispatch（被测的就是它），
  // 但 publish 每次都要过一趟 IPC，突发十几次会触发 Tauri 的 postMessage 回退，噪音盖过信号
  const rec = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    let n = 0;
    const off = bus.subscribe('zz.probe:rec:*', () => { n++; bus.inject('zz.probe:rec:x', {}); });
    let threw = null;
    try { bus.inject('zz.probe:rec:x', {}); } catch (e) { threw = String(e); }
    off();
    let after = 0;
    const off2 = bus.subscribe('zz.probe:after', () => after++);
    bus.inject('zz.probe:after', {});
    off2();
    return { n, threw, after };
  })()`);
  r.check("递归被截断在有限层", true, rec.n > 1 && rec.n <= 12);
  r.check("截断后总线仍可正常派发", 1, rec.after);
  await sleep(600); // console 事件是异步送达的
  r.check("深度上限有明确告警", true, c.noise.some((x) => x.includes("派发递归")));

  r.group("同意框被直接关掉 → 立刻按拒绝结束，不空等 60s");
  const HR = "com.pet.hr-ble";
  const hrManifest = (await invoke_("plugins_list")).v?.find((m) => m.id === HR);
  const savedConfig = await invoke_("store_get", { pluginId: HR, key: "config" });
  await invoke_("permission_revoke", { pluginId: HR });
  const pending = c.ev(
    `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(HR)}, pluginName: '心率蓝牙', capabilities: ['ble:scan'] })`,
  );
  let consentClosed = false;
  try {
    const consent = await driveConsent("close");
    r.check("同意框列出了待授权能力", true, consent.caps.length >= 1);
    r.check("关的是同意框自己的窗口", true, consent.label.startsWith("consent-"));
    consentClosed = true;
  } catch (err) {
    console.log("     没能操作同意框窗口: " + String(err?.message ?? err).split("\n")[0]);
  }
  const raced = await Promise.race([
    pending.then((v) => ({ done: true, v })).catch((e) => ({ done: true, v: "ERR " + e })),
    new Promise((res) => setTimeout(() => res({ done: false }), 15_000)),
  ]);
  r.check("关窗后调用立即返回（未卡满超时）", true, consentClosed && raced.done);
  r.check("按拒绝处理", false, raced.v === true);

  // 还原用户授权：重新走一次同意框并点「允许」
  if (hrManifest?.permissions?.length) {
    const regrant = c.ev(
      `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(HR)}, pluginName: ${JSON.stringify(hrManifest.name)}, capabilities: ${JSON.stringify(hrManifest.permissions)} })`,
    );
    try {
      const again = await driveConsent("allow");
      r.check("重新弹出的同意框带插件名", true, again.name.includes("心率"));
    } catch (err) {
      console.log("     还原授权失败: " + String(err?.message ?? err).split("\n")[0]);
    }
    r.check("点允许后宿主放行", true, await regrant);
    if (savedConfig?.v !== undefined && savedConfig?.v !== null) {
      await invoke_("store_set", { pluginId: HR, key: "config", value: savedConfig.v });
    }
  }

  await c.ev(`localStorage.setItem('host:enabled-plugins', ${JSON.stringify(prevEnabled)})`);
  await reloadAndWait(c);

  r.group("共享资源持有者计数（停用不得误伤他插件）");
  const res = await c.ev(`(async () => {
    const m = await import('/src/runtime/resources.ts');
    m.claim('ble', 'zz.a');
    m.claim('ble', 'zz.b');
    const firstRelease = m.release('ble', 'zz.a');
    const secondRelease = m.release('ble', 'zz.b');
    m.claim('ble-scan', 'zz.c');
    const scanIndependent = m.release('ble', 'zz.c');
    return {
      nonHolderRelease: m.release('ble', 'zz.not-a-holder'),
      firstRelease,
      secondRelease,
      scanIndependent,
    };
  })()`);
  r.check("非持有者 release 不触发释放", false, res.nonHolderRelease);
  r.check("仍有人持有时不释放", false, res.firstRelease);
  r.check("最后一个持有者退出才释放", true, res.secondRelease);
  r.check("ble 与 ble-scan 各自独立计数", false, res.scanIndependent);

  r.group("存储损坏必须报错，不能被当成空表后覆盖");
  const STORE_FILE = join(STORE_DIR, "store.json");
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, "{ 这不是合法 json");
  const brokenRead = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("读取损坏文件返回错误", true, !brokenRead.ok && /损坏/.test(String(brokenRead.e)));
  const brokenWrite = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: 1 });
  r.check("损坏状态下拒绝写入", true, !brokenWrite.ok);
  r.check("原文件未被静默改写", true, readFileSync(STORE_FILE, "utf8").includes("这不是合法"));
  rmSync(STORE_DIR, { recursive: true, force: true });

  r.group("http 代理与按域名授权（#21）");
  // 热安装那组测试结束时删掉了 fixture，这里要自己造回来：
  // 否则宿主报的是「读不到 manifest」，会被误判成鉴权规则失效
  writeFixtures(PLUGINS_DIR);
  await sleep(1200);
  const LOCAL_URL = "http://localhost:1420/index.html";
  const HOST_CAP = "http:localhost:1420";
  const badAsk = await invoke_("permission_request", {
    pluginId: PROBE_ID,
    pluginName: "隔离探针",
    capabilities: [HOST_CAP],
  });
  r.check("未声明 http 的插件不能申请按域名放行", true, !badAsk.ok && /未在 manifest 声明/.test(String(badAsk.e)));

  const grant = c
    .ev(
      `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(NET_ID)}, pluginName: '网络探针', capabilities: ["http", ${JSON.stringify(HOST_CAP)}] })`,
    )
    .catch((e) => "ERR " + e);
  let granted = false;
  try {
    const consent = await driveConsent("allow");
    r.check("http:<host> 视为被 http 覆盖（弹框而非报未声明）", true, consent.caps.some((x) => x.includes("localhost")));
    granted = await grant;
  } catch (err) {
    console.log("     没能走完 http 授权: " + String(err?.message ?? err).split("\n")[0]);
  }
  r.check("域名授权通过后宿主放行", true, granted);

  const fetched = await invoke_("http_request", { pluginId: NET_ID, url: LOCAL_URL });
  r.check("已授权域名能取回内容", true, fetched.v?.status === 200 && String(fetched.v?.body).includes("doctype"));
  const otherHost = await invoke_("http_request", { pluginId: NET_ID, url: "http://127.0.0.1:9/x" });
  r.check("换个域名（localhost ≠ 127.0.0.1）仍被宿主拒绝", true, !otherHost.ok && /未授权/.test(String(otherHost.e)));
  const badScheme = await invoke_("http_request", { pluginId: NET_ID, url: "file:///C:/Windows/win.ini" });
  r.check("非 http/https 协议被拒", true, !badScheme.ok && /只允许 http/.test(String(badScheme.e)));
  const notifyDenied = await invoke_("notify_show", { pluginId: NET_ID, title: "t", body: "b" });
  r.check("未声明 notify 的插件发不出系统通知", true, !notifyDenied.ok && /未授权/.test(String(notifyDenied.e)));
  await invoke_("permission_revoke", { pluginId: NET_ID });

  r.group("示例插件真实挂载（含相对 import 的 topics.js）");
  await c.ev(INSTALL); // 热安装那组末尾重载过页面，宿主句柄要重装（INSTALL 幂等）
  const hr = (await invoke_("plugins_list")).v?.find((m) => m.id === "com.pet.hr-ble");
  r.check("宿主返回了心率插件", true, !!hr?.widget);
  await c.ev(`window.__wh.mount(${JSON.stringify(hr)}, 'badge')`);
  r.check(
    "widget 挂载成功（说明 ./topics.js 在 petplugin 下能解析）",
    true,
    await waitUntil(c, `!!document.querySelector('#widget-badge > div[data-plugin-id="com.pet.hr-ble"]')`),
  );
  await c.ev(`window.__wh.unmount('com.pet.hr-ble')`);

  r.group("渲染几何与帧烘焙（#17 / #20）");
  const geo = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const set = await s.loadSpriteSet(''); // 没有皮肤时的兜底路径：帧仍按 dpr 烘焙
    const style = getComputedStyle(document.documentElement);
    const num = (v) => parseInt(style.getPropertyValue(v) || '0', 10);
    return {
      dpr: window.devicePixelRatio || 1,
      baked: set.idle?.[0]?.width ?? 0,
      frameSize: s.FRAME_SIZE,
      petSize: num('--pet-size'),
      badgeBottom: num('--pet-badge-bottom'),
      bubbleBottom: num('--pet-bubble-bottom'),
      fallbackKeys: Object.keys(set).sort(),
      innerH: window.innerHeight,
    };
  })()`);
  r.check("帧按 devicePixelRatio 烘焙（不再每帧上采样）", Math.round(geo.frameSize * geo.dpr), geo.baked);
  // 本机 dpr 可能是 1，上一条退化成 360=360；强制 2× 才真正验证烘焙机制
  const forced = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const set = await s.loadSpriteSet('', 2);
    return set.idle?.[0]?.width ?? 0;
  })()`);
  r.check("强制 2× 时帧边长翻倍（高分屏不再糊）", geo.frameSize * 2, forced);
  r.check("兜底只提供 idle，不再伪造其余状态", ["idle"], geo.fallbackKeys);
  r.check("立绘尺寸由 JS 写入 CSS 变量", true, geo.petSize > 0);
  r.check("徽标位置跟随立绘几何而非各自硬编", true, geo.badgeBottom > 0 && geo.badgeBottom < geo.innerH);
  r.check("气泡位置同理", true, geo.bubbleBottom > 0 && geo.bubbleBottom <= geo.innerH);

  r.group("petdex 图集几何与九状态切片");
  const slice = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const { PET_STATES, detectSpriteAtlas } = await import('/src/pet/petdex-states.ts');
    const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; };
    // 每格填一种唯一颜色：r 通道=行号，g 通道=列号×30，取中心像素即可反查它来自哪一格
    const paint = (w, h, rows) => {
      const atlas = mk(w, h);
      const g = atlas.getContext('2d');
      for (let r = 0; r < rows; r++) for (let col = 0; col < 8; col++) {
        g.fillStyle = 'rgb(' + r + ',' + (col * 30) + ',0)';
        g.fillRect(col * (w / 8), r * (h / rows), w / 8, h / rows);
      }
      return atlas;
    };
    const center = (cv) => { const p = cv.getContext('2d').getImageData(Math.round(cv.width / 2), Math.round(cv.height / 2), 1, 1).data; return [p[0], p[1], p[2]]; };
    const v1 = paint(1536, 1872, 9);
    const v2 = paint(1536, 2288, 11);
    const set = s.sliceAtlas(v1);
    const counts = {};
    for (const st of PET_STATES) counts[st.id] = set[st.id]?.length ?? 0;
    const probe = { idle2: center(set.idle[2]), review0: center(set.review[0]), failed7: center(set.failed[7]) };
    const set2 = s.sliceAtlas(v2);
    return {
      counts,
      probe,
      v1: detectSpriteAtlas(1536, 1872),
      v2: detectSpriteAtlas(1536, 2288),
      preview: detectSpriteAtlas(1152, 208),
      odd: detectSpriteAtlas(1500, 1872),
      v2States: PET_STATES.every((st) => (set2[st.id]?.length ?? 0) === st.frames),
      v2FrameW: set2.idle[0].width,
    };
  })()`);
  r.check(
    "九个状态各取到自己那一行的帧数",
    JSON.stringify({ idle: 6, "running-right": 8, "running-left": 8, waving: 4, jumping: 5, failed: 8, waiting: 6, running: 6, review: 6 }),
    JSON.stringify(slice.counts),
  );
  r.check("idle 第 3 帧取自第 0 行第 2 列", "0,60,0", slice.probe.idle2.join(","));
  r.check("review 取自第 8 行", "8,0,0", slice.probe.review0.join(","));
  r.check("failed 第 8 帧取自第 5 行第 7 列", "5,210,0", slice.probe.failed7.join(","));
  r.check("v1 图集识别为 8×9", JSON.stringify({ version: 1, rows: 9, width: 1536, height: 1872, scale: 1 }), JSON.stringify(slice.v1));
  r.check("v2 图集识别为 8×11 且只切前九个状态行", true, slice.v2.version === 2 && slice.v2.rows === 11 && slice.v2States);
  r.check("画廊里的 preview.webp（单行 1152×208）不算图集", null, slice.preview);
  r.check("列边界不是整数的图不认", null, slice.odd);

  r.group("状态机优先级与排队上限（#19，词表 = petdex 九状态）");
  const sm = await c.ev(`(async () => {
    const { PetStateMachine } = await import('/src/pet/state-machine.ts');
    const { PET_ACTIONS } = await import('/src/pet/host.ts');
    const mk = () => { const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; return cv; };
    const sprites = {};
    for (const a of PET_ACTIONS) sprites[a] = [mk(), mk()];
    const a = new PetStateMachine(sprites);
    a.request('jumping');
    const b = new PetStateMachine(sprites);
    b.request('jumping');
    for (const act of ['review','review','review']) b.request(act);
    const c2 = new PetStateMachine(sprites);
    c2.request('jumping');
    for (const act of ['review','running','waving','failed']) c2.request(act);
    const capped = c2.queuedCount; // 必须在排空之前取，否则读到的是排空后的 0
    const seq = [];
    for (let i = 0; i < 40; i++) { c2.update(0.1); if (seq[seq.length - 1] !== c2.action) seq.push(c2.action); }
    // waiting 承担原来的「长时间无交互」位：进入后只被交互打断，不被计时打断
    const w = new PetStateMachine(sprites);
    w.request('waiting');
    let stuck = true;
    for (let i = 0; i < 200; i++) { w.update(0.1); if (w.action !== 'waiting') stuck = false; }
    const woke = w.poke('head');
    // 可持续状态（running）重复请求只续期，不该排队
    const d = new PetStateMachine(sprites);
    d.request('running'); d.request('running'); d.request('running');
    return {
      actions: PET_ACTIONS.slice().sort(),
      interrupted: a.action,
      dedup: b.queuedCount,
      capped,
      seq,
      stuck,
      woke,
      renewQueued: d.queuedCount,
      renewAction: d.action,
    };
  })()`);
  r.check(
    "插件可用状态就是 petdex 的九个状态",
    '["failed","idle","jumping","review","running","running-left","running-right","waiting","waving"]',
    JSON.stringify(sm.actions),
  );
  r.check("高优先级请求立即打断当前动作", "jumping", sm.interrupted);
  r.check("同一状态重复请求不叠加排队", 1, sm.dedup);
  r.check("队列有上限，不会无限缓冲", true, sm.capped > 0 && sm.capped <= 3);
  r.check("排队状态会被逐个排空", true, sm.seq.includes("running"));
  r.check("waiting 不被计时打断", true, sm.stuck);
  r.check("交互把 waiting 唤醒成 waving", "waving", sm.woke);
  r.check("可持续状态重复请求只续期不排队", 0, sm.renewQueued);

  r.group("设置面板回显：宿主为 `*:widget` 保留最近一份并回灌新订阅");
  const peek = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    await bus.publish('com.zz.probe:widget', { mode: 'overlay', v: 1 });
    await new Promise((r) => setTimeout(r, 400));
    let got = null;
    const off = bus.subscribe('com.zz.probe:widget', (d) => { got = d; });
    await new Promise((r) => setTimeout(r, 700));
    off();
    let cmdGot = 'no-call';
    const off2 = bus.subscribe('com.zz.probe:cmd', (d) => { cmdGot = d; });
    await new Promise((r) => setTimeout(r, 400));
    off2();
    const peekedCmd = await inv('bus_peek', { topic: 'com.zz.probe:cmd' });
    return { got, cmdGot, peekedCmd };
  })()`);
  r.check("新订阅立刻拿到最近一份 widget 数据", "overlay", peek.got?.mode ?? null);
  r.check("非 widget topic 不会被回灌", "no-call", peek.cmdGot);
  r.check("bus_peek 拒绝非 widget topic", null, peek.peekedCmd);

  r.group("点击穿透判定（#16，注入假光标，不依赖真实鼠标）");
  const ct = await c.ev(`(async () => {
    const { installClickThrough } = await import('/src/pet/click-through.ts');
    const calls = [];
    let fake = { x: 99999, y: 99999 };
    const stop = installClickThrough({
      spriteRect: () => ({ left: 47, top: 47, size: 266 }),
      isDragging: () => false,
      pollMs: 40,
      readCursor: async () => ({ x: fake.x, y: fake.y }),
      windowOrigin: async () => ({ x: 0, y: 0, scale: 1 }),
      setThrough: async (enabled) => { calls.push(enabled); },
    });
    await new Promise((r) => setTimeout(r, 200));
    const outside = calls.slice();
    fake = { x: 180, y: 180 };
    await new Promise((r) => setTimeout(r, 200));
    const afterInside = calls.slice();
    fake = { x: 44, y: 44 }; // 边缘余量内：不该再翻一次
    await new Promise((r) => setTimeout(r, 200));
    const afterEdge = calls.slice();
    stop();
    return { outside, afterInside, afterEdge };
  })()`);
  r.check("指针在实体外时才开启穿透", "[true]", JSON.stringify(ct.outside));
  r.check("指针回到实体内即关闭穿透", "[true,false]", JSON.stringify(ct.afterInside));
  r.check("状态未变时不重复下发（无抖动）", "[true,false]", JSON.stringify(ct.afterEdge));

  r.group("dev 下的 CSP 现状（仅作基线记录，断言在 verify-release.mjs）");
  r.info("探针内 eval", bare.csp);
  r.check("widget 注入 <style> 生效", true, bare.styleApplied);

  r.group("设置窗：分区导航、搜索、快捷键与自启");
  // 用 hostInvoke 而不是裸 evaluate：被拒时页面外的 exceptionDetails 只剩
  // "Uncaught (in promise)"，拿不到宿主给的中文原因，断言就没法校验「为什么被拒」
  const call = hostInvoke(c);
  const sCall = (cmd, args) => hostInvoke(sc)(cmd, args);
  await call("settings_show");
  const findSettings = async () => {
    for (let i = 0; i < 40; i++) {
      const hit = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json()).catch(() => []))
        .find((t) => /localhost:1420\/settings\.html/.test(t.url));
      if (hit) return hit;
      await new Promise((res) => setTimeout(res, 400));
    }
    return null;
  };
  const settingsTarget = await findSettings();
  r.check("设置窗可被宿主唤出（快捷键与回归共用这个入口）", true, !!settingsTarget);
  let sc = settingsTarget
    ? await attach(PORT, (t) => t.webSocketDebuggerUrl === settingsTarget.webSocketDebuggerUrl, 15_000)
    : null;
  if (sc) {
    await new Promise((res) => setTimeout(res, 3000));
    r.check(
      "侧栏六个分区都在",
      '["plugins","skins","hotkey","startup","agent","game"]',
      JSON.stringify(await sc.ev(`[...document.querySelectorAll('.nav-item')].map(b => b.dataset.view)`)),
    );
    r.check("插件卡片带图标位", true, await sc.ev(`document.querySelectorAll('#plugin-list .plugin-card .plugin-icon').length >= 2`));
    await sc.ev(`document.querySelector('.nav-item[data-view=hotkey]').click()`);
    r.check(
      "切页只留一个面板可见",
      "hotkey",
      await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`),
    );
    r.check("非插件页隐藏搜索框", "none", await sc.ev(`getComputedStyle(document.getElementById('search')).display`));
    await sc.ev(`document.querySelector('.nav-item[data-view=plugins]').click()`);
    await new Promise((res) => setTimeout(res, 400));
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = 'ble:scan'; i.dispatchEvent(new Event('input')); })()`);
    r.check(
      "按权限搜索能过滤到只剩声明它的插件",
      1,
      await sc.ev(`[...document.querySelectorAll('#plugin-list .plugin-card')].filter(c => c.style.display !== 'none').length`),
    );
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

    const noMod = await sCall("hotkey_set", { accelerator: "P" });
    r.check("不带修饰键的组合被拒", true, !noMod.ok && /修饰键/.test(String(noMod.e)));
    const twoKeys = await sCall("hotkey_set", { accelerator: "Ctrl+A+B" });
    r.check("两个主键的组合被拒", true, !twoKeys.ok && /主键/.test(String(twoKeys.e)));
    const asDefault = await sCall("hotkey_set", { accelerator: "CommandOrControl+Alt+P" });
    r.check("Tauri 跨平台 token 被接受（默认值本身必须能设）", true, asDefault.ok);
    const moved = await sCall("hotkey_set", { accelerator: "ctrl+alt+f9" });
    r.check("改键成功并归一化", "Ctrl+Alt+F9", moved.v);
    r.check("状态读回的是改后的键", "Ctrl+Alt+F9", (await sCall("hotkey_status")).v?.accelerator);
    r.check("改回默认值", "CommandOrControl+Alt+P", (await sCall("hotkey_set", { accelerator: "CommandOrControl+Alt+P" })).v);

    const auto = await sCall("autostart_status");
    r.check("自启状态带真实路径与 dev 标记", true, typeof auto.v?.devBuild === "boolean" && /\.exe$/.test(auto.v?.exe ?? ""));
    const gated = await call("autostart_set", { enabled: true });
    r.check("自启只能由设置窗改", true, !gated.ok && /设置窗/.test(String(gated.e)));
    const gatedKey = await call("hotkey_set", { accelerator: "Ctrl+Alt+F8" });
    r.check("快捷键只能由设置窗改", true, !gatedKey.ok && /设置窗/.test(String(gatedKey.e)));
    r.check("设置窗自身无报错", [], sc.noise);
    await sCall("plugin:window|close").catch(() => undefined);
    sc.close();
  }

  r.group("宿主页面自身未产生 CSP 违规或未捕获异常");
  // 上面的递归测试会刻意打一条 console.error，它是被测行为的证据，不该混进这里的零容忍
  const unexpected = c.noise.filter((n) => !n.includes("派发递归"));
  r.check("无", 0, unexpected.length);
  if (unexpected.length) unexpected.forEach((n) => console.log("   " + n));
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
