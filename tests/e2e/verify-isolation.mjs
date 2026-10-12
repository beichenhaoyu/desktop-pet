// 隔离与安全回归断言。连到「已在运行」的 dev 实例，跑完给非零退出码即失败。
//   终端 1: npm run dev:debug     终端 2: npm run verify
// 只覆盖 dev 能验证的部分；CSP 与打包路径见 verify-release.mjs（每波次收尾手工跑一次）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, openSettingsInvoker, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";
import { NET_ID, PROBE_ID, SPOOF_DIR, removeFixtures, writeFixtures } from "./fixtures.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PLUGINS_DIR = resolve(import.meta.dirname, "../plugins");
// 没有 APPDATA 时 join('', ...) 会把存储路径指到 cwd 下的相对路径，
// 「文件不在」会被读成「隔离没生效」—— 这类失败必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：定位不到插件存储目录，拒绝开跑。");
  process.exit(2);
}
// store.rs 落在 app_data_dir()/plugins/<id>/；Windows 上 app_data_dir = %APPDATA%/<identifier>
const STORE_DIR = join(env.APPDATA, "com.desktoppet.pet", "plugins", PROBE_ID);
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
    } else if (how === "deny") {
      await cs.ev(`document.getElementById('btn-deny').click()`);
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
// 撤销授权与查看授权表只认设置窗（见 gate.rs：插件 JS 就跑在宠物窗里，
// 不设门禁的话一行 invoke 就能抹掉任意插件的授权并连带清掉其存储）。
// 脚本要撤销时就把设置窗唤出来走这条真实通道，顺带证明宠物窗问同样的命令会被拒。
let settings = null;
async function revoke(pluginId) {
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  return settings.invoke("permission_revoke", { pluginId });
}

/**
 * 用真实同意框给探针拿到某项能力。
 * S1 之后 store_* 在 Rust 侧查授权，S2/S3 之后总线与悬浮层也一样 ——
 * 而 fixture 探针默认零权限，脚本要走的能力必须自己一项项要回来，
 * 顺带证明「manifest 声明 + 用户同意」这条链在宿主侧确实生效。
 */
async function grantProbeCap(capability) {
  const manifestPath = join(PLUGINS_DIR, PROBE_ID, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.permissions?.includes(capability)) {
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, permissions: [...(manifest.permissions ?? []), capability] }, null, 2),
    );
    await sleep(600);
  }
  const checked = await invoke(c)("permission_check", { pluginId: PROBE_ID, capability });
  if (checked.ok && checked.v === true) return true; // 已授权时 permission_request 不弹框，别空等
  // 不等 permission_request 的返回：它会阻塞到用户作答，而 CDP 的 Runtime.evaluate 有 20 秒硬超时
  // （见 cdp.mjs::send），弹框慢一点就会把整条断言链打断。改成应答之后轮询授权表。
  invoke(c)("permission_request", {
    pluginId: PROBE_ID,
    pluginName: manifest.name ?? PROBE_ID,
    capabilities: [capability],
  }).catch(() => undefined);
  try {
    const consent = await driveConsent("allow");
    r.check(`同意框列出了 ${capability}`, true, consent.caps.includes(capability));
  } catch (err) {
    console.log(`     没能操作 ${capability} 的同意框: ` + String(err?.message ?? err).split("\n")[0]);
    return false;
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const now = await invoke(c)("permission_check", { pluginId: PROBE_ID, capability });
    if (now.ok && now.v === true) return true;
    await sleep(400);
  }
  return false;
}
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
  // S2 之后中继那侧还要看授权表，所以这条「放行」得真把 bus:publish 要到手才算端到端
  r.check("探针经同意框拿到 bus:publish", true, await grantProbeCap("bus:publish"));
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

  r.group("覆盖插件代码后不必重载即生效（import 带 cache-busting）");
  // 版本号一字不改、只改代码 —— 这正是 ESM 模块缓存会坑人的形状：URL 恒定的话
  // 关掉再打开拿到的还是内存里那份旧模块，「放进目录即生效」对代码变更就不成立了
  const ver = await invoke_("plugin_file_version", { pluginId: PROBE_ID, rel: "index.js" });
  r.check("宿主能给出文件修改时间", true, Number.isInteger(ver.v) && ver.v > 0);
  const badRel = await invoke_("plugin_file_version", { pluginId: PROBE_ID, rel: "../manifest.json" });
  r.check("越出插件目录的路径拿不到", true, !badRel.ok);
  writeFileSync(
    join(PLUGINS_DIR, PROBE_ID, "index.js"),
    `export function activate(ctx) { window.__probeFlavor = 'B'; }\n` +
      `export function deactivate() { window.__probeDeactivated = (window.__probeDeactivated || 0) + 1; }\n`,
  );
  const swapped = await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    await rt.deactivatePlugin(${JSON.stringify(PROBE_ID)});
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PROBE_ID)}));
    return window.__probeFlavor ?? null;
  })()`);
  r.check("关掉再打开就跑的是新代码", "B", swapped);
  const sameVersion = (await invoke_("plugins_list")).v?.find((m) => m.id === PROBE_ID)?.version;
  r.check("前后是同一个版本号（改的只有代码）", "0.0.0", sameVersion);
  // 上面那次「关掉再打开」本身会跑一次 deactivate：计数器归零再往下断言，
  // 否则下面等的就是上一次的结果，热移除那条路径根本没被等到
  await c.ev(`window.__probeFlavor = null; window.__probeDeactivated = 0; true`);

  removeFixtures(PLUGINS_DIR);
  r.check("移走目录后自动 deactivate", true, await waitUntil(c, `(window.__probeDeactivated ?? 0) >= 1`, 20_000));
  // 容器消失是 deactivate 之后异步拆的，等它真的没了再断言（原来只 sleep 赌一把）
  const removedSelector = `div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
  await waitUntil(c, `document.querySelectorAll(${JSON.stringify(removedSelector)}).length === 0`, 10_000);
  r.check("widget 容器随之移除", 0, await c.ev(`document.querySelectorAll(${JSON.stringify(removedSelector)}).length`));

  r.group("存储门禁：能力授权收在 Rust 侧（绕过 JS 桥的直接 invoke）");
  writeFixtures(PLUGINS_DIR);
  await sleep(1200);
  await revoke(PROBE_ID); // 起点确定：探针手里没有 storage
  const denySet = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: { mode: "badge" } });
  r.check("未授权 storage 的写入被宿主拒绝", true, !denySet.ok && /未授权 storage/.test(String(denySet.e)));
  const denyGet = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("未授权 storage 的读取被宿主拒绝", true, !denyGet.ok && /未授权 storage/.test(String(denyGet.e)));
  const denyDel = await invoke_("store_delete", { pluginId: PROBE_ID, key: "prefs" });
  r.check("未授权 storage 的删除被宿主拒绝", true, !denyDel.ok && /未授权 storage/.test(String(denyDel.e)));
  // 旧的手写检查只挡 `..` `/` `\` 与空串，带冒号的盘符 id 放得过；现在与 is_safe_id 同一口径
  for (const [label, badId] of [["盘符式 id", "C:"], ["分隔符", "a/b"], ["过短", "ab"], ["大写", "Todo"]]) {
    const denied = await invoke_("store_get", { pluginId: badId, key: "prefs" });
    r.check(`${label}（${badId}）按非法 id 被拒`, true, !denied.ok && /invalid plugin id/.test(String(denied.e)));
  }

  r.group("撤销授权连带清理插件存储");
  r.check("声明 storage 并同意后才拿得到读写能力", true, await grantProbeCap("storage"));
  const written = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: { mode: "badge" } });
  r.check("授权后写入成功", true, written.ok === true);
  const readBack = () =>
    c.ev(
      `(async()=>{ try { const v = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE_ID)}, key: 'prefs' }); return v?.mode ?? null; } catch { return "REJECTED"; } })()`,
    );
  r.check("写入可读回", "badge", await readBack());
  r.check("宿主的落盘目录已建", true, existsSync(STORE_DIR));
  const petRevoke = await invoke_("permission_revoke", { pluginId: PROBE_ID });
  r.check("宠物窗撤销授权被门禁拒绝", true, !petRevoke.ok && /设置窗/.test(String(petRevoke.e)));
  const petList = await invoke_("permission_list");
  r.check("宠物窗读授权表同样被拒", true, !petList.ok && /设置窗/.test(String(petList.e)));
  await revoke(PROBE_ID);
  const afterRevoke = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("撤销后同一调用重新被宿主拒绝", true, !afterRevoke.ok && /未授权 storage/.test(String(afterRevoke.e)));
  r.check("落盘目录随之删除", false, existsSync(STORE_DIR));

  r.group("BLE 命令也查授权表（不再是有桥无门的后门）");
  // JS 能力桥一直按 manifest 校验，但 Rust 侧命令原先不认调用者：
  // 绕过桥直接 invoke 的插件扫描/连接任何设备都不需要授权，与自述的能力模型不符
  const scanDenied = await invoke_("ble_start_scan", { pluginId: PROBE_ID });
  r.check("未授权 ble:scan 就扫不动", true, !scanDenied.ok && /未授权/.test(String(scanDenied.e)));
  const connectDenied = await invoke_("ble_connect", { pluginId: PROBE_ID, deviceId: "aa:bb" });
  r.check("未授权 ble:connect 就连不上", true, !connectDenied.ok && /未授权/.test(String(connectDenied.e)));
  const readDenied = await invoke_("ble_connected_device", { pluginId: PROBE_ID });
  r.check("读连接状态同样要授权", true, !readDenied.ok && /未授权/.test(String(readDenied.e)));
  const badId = await invoke_("ble_start_scan", { pluginId: "a/b" });
  r.check("非法插件 id 直接拒", true, !badId.ok && /invalid plugin id/.test(String(badId.e)));

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
  await revoke(HR);
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
  // 期望值就是「false」这个返回值本身：写成断言 raced.v === false 的话，
  // 抛错（v 是 "ERR …"）和超时（v 是 undefined）也会算通过
  r.check("按拒绝处理", false, raced.v);

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
  // 上面那组以撤销收尾，这里要读写就重新走一次同意框（S1 之后宿主按能力放行）
  r.check("重新拿到 storage 授权", true, await grantProbeCap("storage"));
  const STORE_FILE = join(STORE_DIR, "store.json");
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, "{ 这不是合法 json");
  const brokenRead = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("读取损坏文件返回错误", true, !brokenRead.ok && /损坏/.test(String(brokenRead.e)));
  const brokenWrite = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: 1 });
  r.check("损坏状态下拒绝写入", true, !brokenWrite.ok);
  r.check("原文件未被静默改写", true, readFileSync(STORE_FILE, "utf8").includes("这不是合法"));
  rmSync(STORE_DIR, { recursive: true, force: true });

  r.group("总线发布门禁（S2）：topic 归属与 bus:publish 授权收在 Rust 侧");
  // 中继那侧原先不设限：绕过 JS 桥的插件可以往 ble:heart-rate、agent:state 这类
  // 宿主 topic 或他人前缀灌数据，全桌面的窗口都会收到。
  await revoke(PROBE_ID); // 起点确定：上面「正向对照」刚把 bus:publish 授出去
  const pubNoId = await invoke_("bus_publish", { topic: `${PROBE_ID}:self`, payload: { n: 1 } });
  r.check("不带 pluginId 的发布被拒", true, !pubNoId.ok && /需要 pluginId/.test(String(pubNoId.e)));
  const pubOwn = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: `${PROBE_ID}:self`, payload: { n: 1 } });
  r.check("未授权 bus:publish 连自己前缀也发不出", true, !pubOwn.ok && /未授权 bus:publish/.test(String(pubOwn.e)));
  r.check("声明并同意后拿到 bus:publish", true, await grantProbeCap("bus:publish"));
  const pubHost = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: "ble:heart-rate", payload: { bpm: 666 } });
  r.check("有了 bus:publish 也伪造不了宿主 topic", true, !pubHost.ok && /前缀/.test(String(pubHost.e)));
  const pubAgent = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: "agent:state", payload: { state: "idle" } });
  r.check("agent:state 同样灌不进去", true, !pubAgent.ok && /前缀/.test(String(pubAgent.e)));
  const pubForeign = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: "com.pet.hr-ble:bpm", payload: { bpm: 666 } });
  r.check("他人前缀同样被拒", true, !pubForeign.ok && /前缀/.test(String(pubForeign.e)));
  const pubOwnOk = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: `${PROBE_ID}:self`, payload: { n: 2 } });
  r.check("自己前缀照常放行", true, pubOwnOk.ok === true);
  const pubEmptyTopic = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: `${PROBE_ID}:`, payload: {} });
  r.check("光秃秃的前缀不算自己的 topic", true, !pubEmptyTopic.ok && /前缀/.test(String(pubEmptyTopic.e)));
  const pubGone = await invoke_("bus_publish", { pluginId: "zz.gone", topic: "zz.gone:self", payload: {} });
  r.check("没装着的插件借不了名义", true, !pubGone.ok && /没有安装/.test(String(pubGone.e)));
  const pubBadId = await invoke_("bus_publish", { pluginId: "C:", topic: "C:x", payload: {} });
  r.check("非法 id 直接拒", true, !pubBadId.ok && /invalid plugin id/.test(String(pubBadId.e)));

  r.group("悬浮层门禁（S3）：未授权 overlay 开不出置顶窗");
  const ovBadId = await invoke_("overlay_show", { pluginId: "a/b", placement: "corner", height: 120 });
  r.check("非法 id 被拒", true, !ovBadId.ok && /非法的插件 id/.test(String(ovBadId.e)));
  const ovNoGrant = await invoke_("overlay_show", { pluginId: PROBE_ID, placement: "corner", height: 120 });
  r.check("未授权 overlay 的开窗被拒", true, !ovNoGrant.ok && /未授权 overlay/.test(String(ovNoGrant.e)));
  const hideNoGrant = await invoke_("overlay_hide", { pluginId: PROBE_ID });
  r.check("未授权 overlay 的收起同样被拒", true, !hideNoGrant.ok && /未授权 overlay/.test(String(hideNoGrant.e)));
  const destroyNoGrant = await invoke_("overlay_destroy", { pluginId: PROBE_ID });
  r.check("未授权 overlay 的销毁同样被拒", true, !destroyNoGrant.ok && /未授权 overlay/.test(String(destroyNoGrant.e)));
  // 宿主的回收通道不该插件面能用：它只认宠物窗里的运行时
  const reclaimFromSettings = await settings.invoke("overlay_reclaim", { pluginId: PROBE_ID });
  r.check("设置窗调宿主回收通道被窗口门禁拒绝", true, !reclaimFromSettings.ok && /宠物窗/.test(String(reclaimFromSettings.e)));
  r.check("声明并同意后拿到 overlay", true, await grantProbeCap("overlay"));
  const opened = await invoke_("overlay_show", { pluginId: PROBE_ID, placement: "corner", height: 120 });
  r.check("授权后开窗命令被放行", true, opened.ok === true);
  r.check(
    "注册表里有了这一扇",
    true,
    await waitUntil(c, `(async () => (await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id]) => id === ${JSON.stringify(PROBE_ID)}))()`, 10_000),
  );
  await invoke_("overlay_hide", { pluginId: PROBE_ID });
  r.check(
    "授权后收得掉",
    true,
    await waitUntil(
      c,
      `(async () => !(await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id, visible]) => id === ${JSON.stringify(PROBE_ID)} && visible))()`,
      10_000,
    ),
  );
  // 撤销授权后能力没了，插件面的销毁命令会过不去 —— 宿主必须已经把窗收掉，不能留孤儿窗
  await invoke_("overlay_show", { pluginId: PROBE_ID, placement: "corner", height: 120 });
  await revoke(PROBE_ID);
  r.check(
    "撤销授权连带收掉该插件的悬浮层",
    true,
    await waitUntil(
      c,
      `(async () => !(await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id]) => id === ${JSON.stringify(PROBE_ID)}))()`,
      10_000,
    ),
  );
  const reclaimed = await invoke_("overlay_reclaim", { pluginId: PROBE_ID });
  r.check("宿主回收通道在宠物窗里可用（幂等）", true, reclaimed.ok === true);
  // 上面为验证「撤销连带收窗」把探针的能力全撤了；后面的挂载/回显分组还要以它的
  // 名义发消息，这里按同一条真实链路把 bus:publish 要回来（否则中继被拒会往 console 里灌噪音，
  // 打断最后那条「宿主页面自身无告警」的断言）
  r.check("恢复 bus:publish 授权", true, await grantProbeCap("bus:publish"));

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

  // 授权键的口径：桥按 new URL(url).host 申请（默认端口会被省掉），宿主算出来的键必须一致。
  // 早先用 port_or_known_default() 会给 https 凭空补出 `:443`，两边永远对不上，
  // 任何 https 请求都判「未授权」—— 而本地测试地址带显式端口，恰好看不出来。
  const httpsDenied = await invoke_("http_request", { pluginId: NET_ID, url: "https://example.com/" });
  r.check(
    "https 的授权键不带 :443",
    true,
    !httpsDenied.ok && /未授权访问 example\.com：/.test(String(httpsDenied.e)) && !/:443/.test(String(httpsDenied.e)),
  );
  // 给 example.com 走一次真实同意框授权（http 已给过，缺的是这一跳的域名）
  const grantPending = c.ev(
    `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(NET_ID)}, pluginName: '网络探针', capabilities: ['http', 'http:example.com'] })`,
  );
  try {
    await driveConsent("allow");
  } catch (err) {
    console.log("     没能操作 example.com 的同意框: " + String(err?.message ?? err).split("\n")[0]);
  }
  await grantPending.catch(() => null);
  const httpsOk = await invoke_("http_request", { pluginId: NET_ID, url: "https://example.com/" });
  r.check(
    "经宿主代理走 https 能取回内容",
    true,
    httpsOk.v?.status === 200 && /Example Domain/.test(String(httpsOk.v?.body ?? "")),
  );
  const notifyDenied = await invoke_("notify_show", { pluginId: NET_ID, title: "t", body: "b" });
  r.check("未声明 notify 的插件发不出系统通知", true, !notifyDenied.ok && /未授权/.test(String(notifyDenied.e)));
  await revoke(NET_ID);

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

  r.group("渲染几何与帧切片（单份图集 + 每帧源矩形）");
  const geo = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const set = await s.loadSpriteSet(''); // 没有皮肤时的兜底路径
    const style = getComputedStyle(document.documentElement);
    const num = (v) => parseInt(style.getPropertyValue(v) || '0', 10);
    const f = set.idle?.[0];
    return {
      dpr: window.devicePixelRatio || 1,
      // 帧必须是「源矩形 + 单位化目标矩形」，不是一张烘焙画布：
      // 57 帧 × (360×dpr)² 的画布在 dpr=2 时约 118 MB，而图集本身才 12 MB
      isCanvas: !!f && typeof HTMLCanvasElement !== 'undefined' && f instanceof HTMLCanvasElement,
      hasRect: !!f && ['sx','sy','sw','sh','nx','ny','nw','nh'].every((k) => typeof f[k] === 'number'),
      unitRect: f ? [f.nx, f.ny, f.nw, f.nh].every((v) => v >= 0 && v <= 1) : false,
      frameKeys: Object.keys(set),
      petSize: num('--pet-size'),
      badgeBottom: num('--pet-badge-bottom'),
      bubbleBottom: num('--pet-bubble-bottom'),
      fallbackKeys: Object.keys(set).sort(),
      innerH: window.innerHeight,
    };
  })()`);
  r.check("帧不再是烘焙出来的画布", false, geo.isCanvas);
  r.check("每帧带源矩形与单位化目标矩形", true, geo.hasRect);
  r.check("目标矩形落在立绘单位方块内", true, geo.unitRect);
  r.check("兜底只提供 idle，不再伪造其余状态", ["idle"], geo.fallbackKeys);
  r.check("立绘尺寸由 JS 写入 CSS 变量", true, geo.petSize > 0);
  r.check("徽标位置跟随立绘几何而非各自硬编", true, geo.badgeBottom > 0 && geo.badgeBottom < geo.innerH);
  r.check("气泡位置同理", true, geo.bubbleBottom > 0 && geo.bubbleBottom <= geo.innerH);

  // 气泡的水平归属：它属于角色的头顶，不是窗口的右上角。
  // 之前钉在 right:16px，长台词会往角色右侧探出去 30 多像素，整只宠物看起来占了一大块横向空间。
  const bubbleGeo = await c.ev(`(async () => {
    const b = document.getElementById('pet-bubble');
    const { petController, } = await import('/src/pet/host.ts');
    petController().say('一二三四五六七八九〇一二三四五六七八九〇一二三四五六七八九〇一二三四五六七八九〇');
    await new Promise((res) => setTimeout(res, 320));
    const cs = getComputedStyle(document.documentElement);
    const size = parseFloat(cs.getPropertyValue('--pet-size'));
    const left = parseFloat(cs.getPropertyValue('--pet-left'));
    const r = b.getBoundingClientRect();
    return {
      width: Math.round(r.width), size,
      center: +((r.left + r.width / 2) - (left + size / 2)).toFixed(1),
      inside: r.left >= left - 0.5 && r.right <= left + size + 0.5,
      boxSizing: getComputedStyle(b).boxSizing,
    };
  })()`);
  r.check("超长台词也被压在角色宽度内", true, bubbleGeo.inside && bubbleGeo.width <= bubbleGeo.size + 1);
  r.check("气泡水平居中在头顶", true, Math.abs(bubbleGeo.center) <= 3);
  r.check("max-width 含内边距（border-box，否则 padding 让它再宽 24px）", "border-box", bubbleGeo.boxSizing);

  // 真实台词不能顶出窗口上沿：头顶上方的余量只有 47px，两行刚好、三行会被裁
  const longestFit = await c.ev(`(async () => {
    const { pickLine } = await import('/src/pet/dialogue.ts');
    const states = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'wake'];
    let longest = '';
    for (const s of states) for (let i = 0; i < 60; i++) {
      const l = pickLine(s);
      if ([...l].length > [...longest].length) longest = l;
    }
    const { petController } = await import('/src/pet/host.ts');
    petController().say(longest);
    await new Promise((res) => setTimeout(res, 320));
    const r = document.getElementById('pet-bubble').getBoundingClientRect();
    return { chars: [...longest].length, top: Math.round(r.top), lines: Math.max(1, Math.round((r.height - 16) / 19.2)) };
  })()`);
  r.info("最长内置台词", `${longestFit.chars} 字 / ${longestFit.lines} 行`);
  r.check("最长台词也没被窗口上沿裁掉", true, longestFit.top >= 0);

  r.group("已解码图集缓存有上限（换装不再一份份攒下去）");
  const atlasCap = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const mk = (r, g, b) => {
      // 8×8 的真图，走的是和 petdex 图集同一条 loadAtlas 路径
      const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      const g2 = cv.getContext('2d'); g2.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')'; g2.fillRect(0, 0, 8, 8);
      return cv.toDataURL('image/png');
    };
    const urls = [mk(1, 1, 1), mk(2, 2, 2), mk(3, 3, 3), mk(4, 4, 4)];
    for (const u of urls) { try { await s.loadAtlas(u); } catch (e) { return { err: String(e) }; } }
    const after = s.decodedAtlases();
    // 再取一次最近用过的：命中不该新增条目
    await s.loadAtlas(urls[3]);
    return { count: after.length, hasRecent: after.includes(urls[3]), dropped: !after.includes(urls[0]) };
  })()`);
  r.check("加载本身没有报错", undefined, atlasCap.err);
  r.check("四张图装完只留下上限内的份数", true, atlasCap.count > 0 && atlasCap.count <= 2);
  r.check("最近使用的图集留在缓存里", true, atlasCap.hasRecent);
  r.check("最早那张被挤掉了", true, atlasCap.dropped);

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
    const v1 = paint(1536, 1872, 9);
    const v2 = paint(1536, 2288, 11);
    const set = s.sliceAtlas(v1);
    const counts = {};
    for (const st of PET_STATES) counts[st.id] = set[st.id]?.length ?? 0;
    // 帧是「图集上的源矩形」，所以断言直接查它落在第几行第几列：
    // 列 = round(sx / (1536/8))，行 = round(sy / (h/rows))
    const at = (f, w, h, rows) => ({ col: Math.round(f.sx / (w / 8)), row: Math.round(f.sy / (h / rows)) });
    const probe = {
      idle2: at(set.idle[2], 1536, 1872, 9),
      review0: at(set.review[0], 1536, 1872, 9),
      failed7: at(set.failed[7], 1536, 1872, 9),
      // 全部帧共用同一份源图：这才是「不再逐帧烘焙」的关键
      sharesSource: Object.values(set).flat().every((f) => f.source === v1),
      // contain 进正方形：192×208 的单元格按长边缩放，窄边居中留边
      fits: set.idle.map((f) => f.nw <= 1 && f.nh <= 1 && Math.abs(Math.max(f.nw, f.nh) - 1) < 1e-6),
    };
    const set2 = s.sliceAtlas(v2);
    return {
      counts,
      probe,
      v1: detectSpriteAtlas(1536, 1872),
      v2: detectSpriteAtlas(1536, 2288),
      preview: detectSpriteAtlas(1152, 208),
      odd: detectSpriteAtlas(1500, 1872),
      v2States: PET_STATES.every((st) => (set2[st.id]?.length ?? 0) === st.frames),
      v2Idle8Row: at(set2.idle[0], 1536, 2288, 11).row,
    };
  })()`);
  r.check(
    "九个状态各取到自己那一行的帧数",
    JSON.stringify({ idle: 6, "running-right": 8, "running-left": 8, waving: 4, jumping: 5, failed: 8, waiting: 6, running: 6, review: 6 }),
    JSON.stringify(slice.counts),
  );
  r.check("idle 第 3 帧取自第 0 行第 2 列", JSON.stringify({ col: 2, row: 0 }), JSON.stringify(slice.probe.idle2));
  r.check("review 取自第 8 行", JSON.stringify({ col: 0, row: 8 }), JSON.stringify(slice.probe.review0));
  r.check("failed 第 8 帧取自第 5 行第 7 列", JSON.stringify({ col: 7, row: 5 }), JSON.stringify(slice.probe.failed7));
  r.check("所有帧共用同一份源图（没有逐帧画布）", true, slice.probe.sharesSource);
  r.check("contain 缩放：长边占满单位方块、没有超出", true, slice.probe.fits.every(Boolean) && slice.probe.fits.length === 6);
  r.check("v1 图集识别为 8×9", JSON.stringify({ version: 1, rows: 9, width: 1536, height: 1872, scale: 1 }), JSON.stringify(slice.v1));
  r.check("v2 图集识别为 8×11 且只切前九个状态行", true, slice.v2.version === 2 && slice.v2.rows === 11 && slice.v2States);
  r.check("v2 的行高按 11 行算（idle 仍在第 0 行）", 0, slice.v2Idle8Row);
  r.check("画廊里的 preview.webp（单行 1152×208）不算图集", null, slice.preview);
  r.check("列边界不是整数的图不认", null, slice.odd);

  r.group("状态机优先级与排队上限（#19，词表 = petdex 九状态）");
  const sm = await c.ev(`(async () => {
    const { PetStateMachine } = await import('/src/pet/state-machine.ts');
    const { PET_ACTIONS } = await import('/src/pet/host.ts');
    const mk = () => { const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; return cv; };
    const frame = () => ({ source: mk(), sx: 0, sy: 0, sw: 1, sh: 1, nx: 0, ny: 0, nw: 1, nh: 1 });
    const sprites = {};
    for (const a of PET_ACTIONS) sprites[a] = [frame(), frame()];
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
    // 兜底皮肤只有 idle 帧（没有 waiting 那一行）：挂机检测整条不该成立，
    // 否则 switchTo 每帧回落 idle、onSleep 每帧重放，台词被 60fps 反复触发
    const only = { idle: [frame(), frame()] };
    const e = new PetStateMachine(only);
    let slept = 0;
    e.onSleep = () => { slept += 1; };
    for (let i = 0; i < 120; i++) e.update(1); // 120 秒无交互
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
      fallbackSleeps: slept,
      fallbackAction: e.action,
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
  r.check("缺 waiting 帧时不反复触发挂机回调", 0, sm.fallbackSleeps);
  r.check("缺 waiting 帧时角色仍停在 idle", "idle", sm.fallbackAction);

  r.group("设置面板回显：宿主为 `*:widget` 保留最近一份并回灌新订阅");
  // 中继现在认发布名义与能力（S2）：`:widget` 那条走 widget 能力
  r.check("拿到 widget 能力后才测得了回灌", true, await grantProbeCap("widget"));
  const peek = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const PID = ${JSON.stringify(PROBE_ID)};
    await bus.publish(\`\${PID}:widget\`, { mode: 'overlay', v: 1 }, PID);
    await new Promise((r) => setTimeout(r, 400));
    let got = null;
    const off = bus.subscribe(\`\${PID}:widget\`, (d) => { got = d; });
    await new Promise((r) => setTimeout(r, 700));
    off();
    let cmdGot = 'no-call';
    const off2 = bus.subscribe(\`\${PID}:cmd\`, (d) => { cmdGot = d; });
    await new Promise((r) => setTimeout(r, 400));
    off2();
    const peekedCmd = await inv('bus_peek', { topic: \`\${PID}:cmd\` });
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

  r.group("窗口被拖走之后穿透不会卡死（原点必须跟着更新）");
  // 这条是「拖一次之后宠物再也点不到」的回归：光标停在宠物身上不动，
  // 而窗口原点过期 → 判定「在实体外」→ 穿透打开；穿透开着就收不到 DOM 事件，
  // 只靠「翻转时重读原点」永远回不来。所以拖动后必须自愈。
  const heal = await c.ev(`(async () => {
    const { installClickThrough } = await import('/src/pet/click-through.ts');
    const calls = [];
    let reads = 0;
    let origin = { x: 0, y: 0, scale: 1 };
    const cursor = { x: 5000, y: 5000 }; // 先在远处：穿透应当打开
    const stop = installClickThrough({
      spriteRect: () => ({ left: 47, top: 47, size: 266 }),
      isDragging: () => false,
      pollMs: 40,
      readCursor: async () => ({ x: cursor.x, y: cursor.y }),
      windowOrigin: async () => { reads++; return { x: origin.x, y: origin.y, scale: origin.scale }; },
      setThrough: async (enabled) => { calls.push(enabled); },
    });
    await new Promise((r) => setTimeout(r, 150));
    const armed = calls.slice();
    // 宠物被拖到指针底下：光标一步没动，旧原点会说「还在实体外」
    origin = { x: cursor.x - 180, y: cursor.y - 180, scale: 1 };
    const t0 = Date.now();
    let reopened = false;
    while (Date.now() - t0 < 2500) {
      if (calls.length > armed.length && calls[calls.length - 1] === false) { reopened = true; break; }
      await new Promise((r) => setTimeout(r, 40));
    }
    const after = calls.slice();
    stop();
    return { armed, after, reopened, reads };
  })()`);
  r.check("起手指针在实体外，穿透打开", "[true]", JSON.stringify(heal.armed));
  r.check("宠物挪到指针底下后穿透自己关掉", true, heal.reopened);
  r.check("关掉只发生一次（不来回抖）", 1, heal.after.filter((v) => v === false).length);

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
    const installed = (await sCall("plugins_list")).v ?? [];
    const enabledIds = JSON.parse(await sc.ev(`localStorage.getItem('host:enabled-plugins') ?? '[]'`));
    const navViews = () =>
      sc.ev(`[...document.querySelectorAll('#nav-list .nav-item')].map(b => b.dataset.view).join(',')`);

    r.group("侧栏结构：宠物设置 + 插件列表");
    r.check(
      "第一项是宠物设置，其余每个已装插件一项",
      "pet," + installed.map((m) => m.id).sort().join(","),
      await navViews(),
    );
    r.check(
      "宠物设置这一页含形象/快捷键/自启/游戏模式四张卡片（Agent 卡片已移交插件页）",
      '["桌宠形象","唤出本页的全局快捷键","开机自动运行","游戏模式"]',
      JSON.stringify(await sc.ev(`[...document.querySelectorAll('[data-panel=pet] .card h2')].map(h => h.textContent)`)),
    );
    r.check(
      "宠物设置里含形象/快捷键/自启/游戏模式的控件",
      '[true,true,true,true,true,true]',
      JSON.stringify(await sc.ev(
        `['skin-list','hotkey-input','autostart-switch','game-mode-switch','skin-name','hotkey-test']` +
          `.map(id => !!document.getElementById(id))`,
      )),
    );
    r.check(
      "Agent 卡片的 DOM 与控件已删干净（不留死代码）",
      '[false,false,false,false,false]',
      JSON.stringify(await sc.ev(
        `['agent-status','agent-detail','agent-install','agent-uninstall','agent-refresh'].map(id => !!document.getElementById(id))`,
      )),
    );
    r.check("初始只有 pet 面板可见", "pet", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));

    r.group("点插件 → 插件页（内容交给插件的 widget）");
    // 用零权限探针：开它的开关不会在宠物窗那边弹同意框，断言不会被授权对话框卡住
    r.check("探针此刻是停用态（下面要验开关流程）", false, enabledIds.includes(PROBE_ID));
    await sc.ev(`document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}]').click(); true`);
    await new Promise((res) => setTimeout(res, 500));
    r.check("切过去只留插件面板", "plugin", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));
    r.check("标题换成插件名", "隔离探针", await sc.ev(`document.getElementById('view-title').textContent`));
    r.check("壳上给了 id 与权限列表", true, await sc.ev(`document.getElementById('plugin-id').textContent === ${JSON.stringify(PROBE_ID)} && document.querySelectorAll('#plugin-perms .perm-chip').length === 0`));
    r.check(
      "停用状态下不挂插件页面，并说明原因",
      true,
      await sc.ev(
        `!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}]')` +
          ` && !document.getElementById('plugin-note').hidden && /启用后/.test(document.getElementById('plugin-note').textContent)`,
      ),
    );
    // 在插件页里开开关：widget 应挂进 #plugin-settings，内容是插件自己的
    await sc.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); })()`);
    const mountedInPage = await waitUntil(
      sc,
      `!!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}][data-region="settings"]')`,
      12_000,
    );
    r.check("启用后插件自己的设置页挂进来了", true, mountedInPage);
    r.check("侧栏那个点跟着变亮", true, await sc.ev(`!!document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}] .nav-dot.on')`));
    await sc.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = false; t.dispatchEvent(new Event('change')); })()`);
    await sleep(1200);
    r.check(
      "停用后 widget 摘干净（不留孤儿节点）",
      0,
      await sc.ev(`document.querySelectorAll('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}]').length`),
    );

    r.group("搜索过滤的是插件列表");
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = 'ble:scan'; i.dispatchEvent(new Event('input')); })()`);
    r.check(
      "按权限搜索只剩声明它的插件",
      1,
      await sc.ev(`[...document.querySelectorAll('#nav-plugins .nav-item')].filter(b => b.style.display !== 'none').length`),
    );
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    r.check("清空搜索后侧栏恢复完整", installed.length, await sc.ev(`[...document.querySelectorAll('#nav-plugins .nav-item')].filter(b => b.style.display !== 'none').length`));

    // 上面只是把探针开了又关，清单该回到起点
    const afterToggle = JSON.parse(await sc.ev(`localStorage.getItem('host:enabled-plugins') ?? '[]'`));
    r.check("插件启停回到起点", JSON.stringify([...enabledIds].sort()), JSON.stringify([...afterToggle].sort()));
    await sc.ev(`document.querySelector('.nav-item[data-view=pet]').click(); true`);
    await new Promise((res) => setTimeout(res, 400));
    r.check("回到宠物设置", "pet", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));
    r.check("离开插件页后插件页被卸载", 0, await sc.ev(`document.querySelectorAll('#plugin-settings div[data-plugin-id]').length`));

    // ---------- B2：agent:hooks 受控能力（settings 区专属，ADR-0001） ----------
    // 探针复用 zz.probe 目录（.gitignore 已忽略、收尾统一删除）。把它的 widget 换成
    // 「钩子能力探针」：mount 本身不发起任何调用，只把 ctx 形状与手动调用函数挂到 window，
    // 免得早先的挂载/开关用例被同意框打断。
    r.group("agent:hooks 受控能力（settings 区专属）");
    const TEMP_ROOT = resolve(import.meta.dirname, "../temp");
    const hookDir = join(PLUGINS_DIR, PROBE_ID);
    const hookManifest = (permits) =>
      JSON.stringify({
        id: PROBE_ID,
        name: "钩子能力探针",
        version: "0.0.0",
        entry: "index.js",
        widget: "widget.js",
        permissions: permits,
        description: "验证 agent:hooks 的受控注入面与同意流程。",
      });
    const HOOK_WIDGET = `export function mount(root, ctx) {
  const api = ctx.host && ctx.host.agentHooks;
  const entry = {
    region: ctx.region,
    hostIsUndefined: typeof ctx.host === "undefined",
    hasAgentHooks: !!api,
    keys: ctx.host ? Object.keys(ctx.host).sort() : [],
  };
  entry.call = async (name) => {
    if (!api) return { ok: false, e: "no host.agentHooks on ctx" };
    try { return { ok: true, v: await api[name]() }; }
    catch (e) { return { ok: false, e: String(e && e.message ? e.message : e) }; }
  };
  (window.__hookProbes = window.__hookProbes || {})[ctx.region] = entry;
}
export function unmount() {}
`;
    const MOUNT_HOOK_PROBES = `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      window.__hookHost = widgetHost;
      document.getElementById('hook-probe-slot')?.remove();
      const slot = document.createElement('div');
      slot.id = 'hook-probe-slot';
      document.body.append(slot);
      const manifest = ${hookManifest([])};
      await widgetHost.mount(manifest, 'settings', slot);
      await widgetHost.mount(manifest, 'badge', slot);
      await widgetHost.mount(manifest, 'overlay', slot);
      return Object.keys(window.__hookProbes || {}).sort().join(',');
    })()`;

    writeFileSync(join(hookDir, "widget.js"), HOOK_WIDGET);
    writeFileSync(join(hookDir, "manifest.json"), hookManifest([]));
    mkdirSync(join(TEMP_ROOT, "b2"), { recursive: true });
    await sleep(900);

    r.check("探针在 settings/badge/overlay 三区都能挂上", "badge,overlay,settings", await sc.ev(MOUNT_HOOK_PROBES));
    const shape = await sc.ev(`({
      hasAgentHooks: window.__hookProbes.settings.hasAgentHooks,
      keys: window.__hookProbes.settings.keys.join(','),
      badgeHost: window.__hookProbes.badge.hostIsUndefined,
      badgeApi: window.__hookProbes.badge.hasAgentHooks,
      overlayHost: window.__hookProbes.overlay.hostIsUndefined,
      overlayApi: window.__hookProbes.overlay.hasAgentHooks,
    })`);
    r.check("settings 区注入 ctx.host.agentHooks（且只有这一个键）", true, shape.hasAgentHooks === true && shape.keys === "agentHooks");
    r.check("badge 区取到的 ctx.host 是 undefined（断言 undefined，不是调用报错）", true, shape.badgeHost === true && shape.badgeApi === false);
    r.check("overlay 区取到的 ctx.host 是 undefined", true, shape.overlayHost === true && shape.overlayApi === false);

    // 起点确定：清掉上一次（可能崩溃留下）的旧授权，否则 permission_check 会短路掉声明校验
    await sCall("permission_revoke", { pluginId: PROBE_ID });
    const undeclared = await sc.ev(`window.__hookProbes.settings.call("status")`);
    r.check(
      "未声明 agent:hooks：settings 区调用被拒（未声明的能力不弹框，直接拒）",
      true,
      undeclared.ok === false && /未在 manifest 声明/.test(undeclared.e),
    );

    // 声明后：首次调用应弹同意框。先拒绝一次，再同意。
    writeFileSync(join(hookDir, "manifest.json"), hookManifest(["agent:hooks"]));
    await sleep(500);
    const pendingDeny = sc.ev(`window.__hookProbes.settings.call("status")`);
    const consentDeny = await driveConsent("deny");
    r.check("同意框列出了 agent:hooks", true, consentDeny.caps.some((x) => x.includes("agent:hooks")));
    // 同意框标题是既有文案 `${plugin_name}（${plugin_id}）`（consent/main.ts:34），断言整串
    r.check("同意框显示的是探针插件名（既有文案含 id）", "钩子能力探针（zz.probe）", consentDeny.name);
    const denied = await pendingDeny;
    r.check("拒绝后调用被拒（默认拒绝语义）", true, denied.ok === false && /权限被拒绝/.test(denied.e));

    const pendingAllow = sc.ev(`window.__hookProbes.settings.call("status")`);
    const consentAllow = await driveConsent("allow");
    r.check("拒绝没留下授权（第二次调用仍弹框）", true, consentAllow.caps.some((x) => x.includes("agent:hooks")));
    const allowed = await pendingAllow;
    r.check("同意后 settings 区调用放行", true, allowed.ok === true);
    const hostStatus = await sCall("agent_hooks_status");
    r.check("status 回显与宿主路径一致", JSON.stringify(allowed.v), JSON.stringify(hostStatus.v));

    // 宠物窗主 realm：绕过 JS 桥直接 invoke 必须被窗口门禁拒（label=pet）
    const petStatus = await call("agent_hooks_status");
    r.check("宠物窗直接 invoke status 被拒（label=pet）", true, petStatus.ok === false && /设置窗/.test(String(petStatus.e)));
    const petInstall = await call("agent_hooks_install", { pluginId: PROBE_ID });
    r.check("宠物窗带 pluginId 的 install 同样被窗口门禁拒", true, petInstall.ok === false && /设置窗/.test(String(petInstall.e)));

    // 写盘类断言只在宿主被指到 temp/ 时跑（PET_AGENT_CONFIG_FILES 启动方式）；
    // 否则一律不改写真实用户配置，只做只读断言。
    const statusFiles = Array.isArray(allowed.v?.files) ? allowed.v.files : [];
    const underTemp = statusFiles.length > 0 && statusFiles.every((f) => resolve(String(f.path)).startsWith(TEMP_ROOT + sep));
    r.info("hook 配置落点", statusFiles.map((f) => f.path).join(" ； ") || "(空)");

    let sampleForeign = "";
    // 「他人条目未变」的比较口径：宿主用 serde_json 整文件重写（BTreeMap 按键排序），
    // 键序会被归一 —— 两侧都按键排序后比较（与 Rust 单测同口径），键序差异不算改动。
    const canon = (value) => {
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canon(value[k]);
        return out;
      }
      return value;
    };
    const foreignOf = (text) => {
      const v = JSON.parse(text);
      return JSON.stringify([canon(v.hooks.PreToolUse[0].hooks[0]), canon(v.hooks.Stop[0].hooks[0])]);
    };
    if (underTemp) {
      const sample = JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PreToolUse: [{ hooks: [
              { type: "command", command: "other-tool --notify", timeout: 5 },
              { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook pre`, timeout: 2 },
            ] }],
            Stop: [{ hooks: [{ type: "command", command: "keep.sh", timeout: 3 }] }],
          },
        },
        null,
        2,
      );
      for (const f of statusFiles) writeFileSync(f.path, sample);
      sampleForeign = foreignOf(sample);

      const installRes = await sc.ev(`window.__hookProbes.settings.call("install")`);
      r.check(
        "声明并同意后 install 成功（每个文件回显条数）",
        true,
        installRes.ok === true && Array.isArray(installRes.v?.files) && installRes.v.files.every((f) => f.managed > 0 && !f.error),
      );
      const afterInstall = (await sCall("agent_hooks_status")).v;
      r.check("install 后 status 回显条数与文件数一致", afterInstall.managed, statusFiles.length * afterInstall.expectedPerFile);
      for (const f of statusFiles) {
        const text = readFileSync(f.path, "utf8");
        r.check("install 后样例只有自家条目在增", afterInstall.expectedPerFile, text.split("--pet-hook").length - 1);
        r.check("install 后他人 hook 条目逐字段未变（键序由宿主归一）", sampleForeign, foreignOf(text));
      }
    } else {
      r.info(
        "跳过写盘断言",
        "hook 配置未指向 temp/：install 与「连带卸载」断言不做（会改写真实用户配置）；" +
          '用 PET_AGENT_CONFIG_FILES="<temp>\\a.json;<temp>\\b.json" npm run dev:debug 启动可跑全量',
      );
    }

    // ---------- 撤销授权两条分支（CONTEXT.md 生命周期） ----------
    // 先重载设置窗：manifest 改写后要拿到刷新过的权限列表（nav 的 data-search 带权限名）。
    await reloadAndWait(sc);
    r.check(
      "设置页在 manifest 改写后刷新出 agent:hooks 权限",
      true,
      await waitUntil(sc, `document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}]')?.dataset.search?.includes('agent:hooks') === true`, 10_000),
    );
    // 重载把 window 上的探针句柄与桥缓存都清了：重新挂一次、再走一次 status 把缓存填上
    await sc.ev(MOUNT_HOOK_PROBES);
    const regrant = await sc.ev(`window.__hookProbes.settings.call("status")`);
    r.check("重载后凭已授权记录直接放行（不再弹框）", true, regrant.ok === true);

    // 所有点击都先等元素出现、缺了产出可读 FAIL —— 固定 sleep 赌渲染会在缺元素时抛
    // TypeError 把整个套件打断（上一轮就是这么丢掉尾部汇总的）。
    // 注意：撤销按钮是 **class** `btn-revoke`（settings/main.ts:158 用 el() 的第三参赋 className），
    // 不是 id —— 上一轮用 getElementById 查它永远为 null，是脚本选择器写错，不是产品缺口。
    const clickReady = async (selector) => {
      const ready = await waitUntil(sc, `!!document.querySelector(${JSON.stringify(selector)})`, 8_000).catch(() => false);
      if (ready) await sc.ev(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
      return ready;
    };

    const navOpened = await clickReady(`.nav-item[data-view=${JSON.stringify(PROBE_ID)}]`);
    const hasRevokeBtn = navOpened && (await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false));
    r.check("插件壳上出现「撤销授权」（class=btn-revoke，声明列表已刷新）", true, hasRevokeBtn);

    // 分支一「只撤能力」：不写 hook 配置文件，任何模式都可跑
    const beforeSnap = JSON.stringify((await sCall("agent_hooks_status")).v);
    const beforeBytes = underTemp ? statusFiles.map((f) => readFileSync(f.path, "utf8")) : [];
    r.check(
      "撤销前桥缓存里有 agent:hooks（下面「失效」才是真的变化）",
      true,
      (await sc.ev(`(async () => (await import('/src/runtime/bridge.ts')).grantedCapabilities(${JSON.stringify(PROBE_ID)}).includes('agent:hooks'))()`)) === true,
    );
    if (hasRevokeBtn) await clickReady(".btn-revoke");
    const stripUp = hasRevokeBtn === true && (await waitUntil(sc, `document.getElementById('revoke-uninstall')?.checked === true`, 5_000).catch(() => false));
    r.check("确认条默认勾选「同时卸载 hook」", true, stripUp);
    if (stripUp) {
      await sc.ev(`(() => { document.getElementById('revoke-uninstall').checked = false; return true; })()`);
      await clickReady("#revoke-go");
    }
    r.check(
      "「只撤能力」的回显",
      true,
      stripUp && (await waitUntil(sc, `document.querySelector('.btn-revoke')?.textContent.includes("仅能力") === true`, 8_000).catch(() => false)),
    );
    r.check(
      "确认条执行后收起",
      0,
      stripUp ? await sc.ev(`document.querySelectorAll('#revoke-confirm').length`) : "撤销流程未执行（前一步失败）",
    );
    r.check("「只撤能力」不动 hook 配置（宿主回显不变）", beforeSnap, JSON.stringify((await sCall("agent_hooks_status")).v));
    if (underTemp) {
      r.check("「只撤能力」后样例文件字节不变", true, statusFiles.every((f, i) => readFileSync(f.path, "utf8") === beforeBytes[i]));
    }
    // 撤销后缓存失效是异步广播（host:permission-revoked）：轮询断言，别一次性查询竞态
    r.check(
      "「只撤能力」后桥的能力缓存失效",
      true,
      await waitUntil(sc, `(async () => !(await import('/src/runtime/bridge.ts')).grantedCapabilities(${JSON.stringify(PROBE_ID)}).includes('agent:hooks'))()`, 5_000),
    );

    // 分支二「连带卸载」：写盘，仅 temp 模式
    if (underTemp) {
      await clickReady(`.nav-item[data-view=pet]`);
      await clickReady(`.nav-item[data-view=${JSON.stringify(PROBE_ID)}]`);
      const hasBtn2 = await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false);
      r.check("重新进入插件页后撤销按钮再次可用", true, hasBtn2);
      if (hasBtn2) await clickReady(".btn-revoke");
      const stripUp2 = hasBtn2 === true && (await waitUntil(sc, `document.getElementById('revoke-uninstall')?.checked === true`, 5_000).catch(() => false));
      r.check("第二次确认条默认勾选（不取消，走连带卸载）", true, stripUp2);
      if (stripUp2) await clickReady("#revoke-go");
      r.check(
        "「连带卸载」的回显",
        true,
        stripUp2 && (await waitUntil(sc, `document.querySelector('.btn-revoke')?.textContent.includes("含卸载 hook") === true`, 8_000).catch(() => false)),
      );
      const clean = (await sCall("agent_hooks_status")).v;
      r.check("「连带卸载」后配置文件干净", 0, clean.managed ?? -1);
      for (const f of statusFiles) {
        const text = readFileSync(f.path, "utf8");
        r.check("卸载后 --pet-hook 条目归零", 0, text.split("--pet-hook").length - 1);
        r.check("卸载后他人 hook 条目逐字段未变（键序由宿主归一）", sampleForeign, foreignOf(text));
      }
    }

    await sc.ev(`(async () => { await window.__hookHost.unmount(${JSON.stringify(PROBE_ID)}); document.getElementById('hook-probe-slot')?.remove(); return true; })()`);
    await clickReady(`.nav-item[data-view=pet]`);

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
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(c.transitionNoise.length));
  const unexpected = c.noise.filter((n) => !n.includes("派发递归"));
  r.check("无", 0, unexpected.length);
  if (unexpected.length) unexpected.forEach((n) => console.log("   " + n));
} catch (err) {
  // 断言中途抛错时别只丢一个栈：给出可读原因
  aborted = true;
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  removeFixtures(PLUGINS_DIR);
  settings?.close();
  c?.close();
  // 等 websocket 真正关掉再退出，否则 Windows 上 Node 会在 stderr 抛一句 libuv 断言
  await new Promise((res) => setTimeout(res, 300));
}

process.exit(aborted || r.summary() ? 1 : 0);
