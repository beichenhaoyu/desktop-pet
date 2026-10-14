// L1 原型（ADR-0006）运行时取证：插件搬进 Web Worker 之后，
//   ① realm 事实（没有 window/document/localStorage、__TAURI_INTERNALS__ 不可达、裸说明符解析不了）
//   ② 入口的相对子模块在 Worker 里能否解析（todo 的 ./todo-txt.js、探针的 ./leaf.js）
//   ③ petplugin 的 `?v=` 与 no-store 在 Worker 的取回路径上是否仍成立
//   ④ 协议层伪造（不在 22 个方法表里的调用、跨插件读存储）是否被宿主挡下
//   ⑤ 退出条件：com.pet.todo 在 Worker 里真的跑得动
// 取证方式是本仓唯一合法姿势：读页面/Worker 自己写下的副作用，不用 CDP 求值判 CSP。
//   终端 1: npm run dev:debug      终端 2: npm run verify:worker
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";
import {
  attach,
  createReport,
  hostInvoke,
  listPages,
  openSettingsInvoker,
  readEnabledIds,
  reloadAndWait,
  waitUntil,
  writeEnabledIds,
} from "./harness/cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(REPO, "tests", "fixtures", "l1-probe");
const INSTALLED = join(REPO, "plugins", "zz.l1-probe");
const PROBE = "zz.l1-probe";
const TODO = "com.pet.todo";
const FLAG = "host:worker-plugin-host";
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("L1 Worker 宿主（dev）");

let stopped = false;
/** 同意框逐个能力分批弹，必须整轮持续应答（授权只能走真实同意框） */
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

function installFixture() {
  mkdirSync(INSTALLED, { recursive: true });
  for (const file of ["manifest.json", "index.js", "leaf.js"]) {
    copyFileSync(join(FIXTURE, file), join(INSTALLED, file));
  }
}

/** 把已装探针的 leaf.js 改成别的标记值：量「子模块内容变了而 URL 没变」时 Worker 拿到的是哪一份 */
function markLeaf(value) {
  writeFileSync(join(INSTALLED, "leaf.js"), `export const LEAF_MARKER = ${JSON.stringify(value)};\n`);
}

/** L1 原型的开关就这一个键：逗号分隔的插件 id 名单（缺省为空 = 老路径） */
const setFlag = (client, ids) =>
  client.ev(`localStorage.setItem(${JSON.stringify(FLAG)}, ${JSON.stringify(ids.join(","))})`);

let c = null;
let cdp = null;
let settings = null;
let origEnabled = [];
let invoked = false;

try {
  if (!existsSync(join(FIXTURE, "manifest.json"))) throw new Error(`探针夹具缺失: ${FIXTURE}`);
  installFixture();
  invoked = true;

  try {
    c = await attach(PORT, isPetPage, 60_000);
  } catch {
    console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
    process.exit(2);
  }
  cdp = c;
  const invoke = hostInvoke(c);
  settings = await openSettingsInvoker(PORT, c);
  origEnabled = await readEnabledIds(invoke);
  void pump(420_000);

  r.group("装载");
  await settings.invoke("permission_revoke", { pluginId: PROBE });
  await sleep(1200);
  const enabled = [...new Set([...origEnabled, PROBE])];
  await writeEnabledIds(settings.invoke, enabled);
  await setFlag(c, [PROBE]);
  await reloadAndWait(c);
  r.check(
    "探针在 Worker 里 activate 成功",
    true,
    await waitUntil(
      c,
      `(async () => { try { return (await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE)}, key: 'booted' })) === true; } catch { return false; } })()`,
      30_000,
    ),
  );

  const storeGet = async (key) => (await invoke("store_get", { pluginId: PROBE, key })).v;
  const facts = await storeGet("facts");
  r.info("入口 URL", String(facts?.entryUrl));
  r.info("裸说明符解析失败的原因", String(facts?.bareImportText));
  r.info("Worker 里 fetch ipc.localhost 的结果", `${facts?.ipcFetch} ${String(facts?.ipcFetchText ?? "")}`);

  r.group("① realm 事实：真隔离成立");
  r.check("ctx.pluginId 是宿主分配的", PROBE, facts?.ctxId);
  r.check("Worker 里没有 window", false, facts?.hasWindow);
  r.check("Worker 里没有 document", false, facts?.hasDocument);
  r.check("Worker 里没有 localStorage", false, facts?.hasLocalStorage);
  r.check("__TAURI_INTERNALS__ 不可达", false, facts?.hasInternals);
  r.check("裸说明符 @tauri-apps/api/core 解析不了", "rejected", facts?.bareImport);
  r.check("取 ipc.localhost 拿不到可用通道", true, !String(facts?.ipcFetch).startsWith("status:2"));

  r.group("② 入口的相对子模块在 Worker 里解析");
  r.check("./leaf.js 被 Worker 取到并执行", "leaf-v1", facts?.leaf);
  r.check("入口 URL 带上了 ?v= 令牌", true, /\?v=\d+/.test(String(facts?.entryUrl)));

  r.group("④ 协议层伪造被宿主挡下");
  r.check("表外方法被拒", false, facts?.forged?.unknownMethod?.ok);
  r.check("拒绝带码", true, typeof facts?.forged?.unknownMethod?.code === "string");
  r.check("冒名调别的插件的撤销命令也进不来", false, facts?.forged?.revokeOther?.ok);
  r.check("借表内方法发别人的 topic 被前缀归属拦下", false, facts?.forged?.publishAsOther?.ok);
  r.check("跨插件读不到别人的存储", null, facts?.crossPluginRead);

  r.group("③ 覆盖子模块：同一个 Worker 陈旧、换一个 Worker 取新");
  markLeaf("leaf-v2");
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${PROBE}:cmd`)}, { tag: "ping-1" }, ${JSON.stringify(PROBE)});
  })()`);
  await sleep(2500);
  const last = await storeGet("last");
  r.check("事件经通道推回了 Worker", "ping-1", last?.echo?.tag);
  r.check("同一个 Worker 里 URL 不变的子模块仍是旧实例", "leaf-v1", last?.facts?.leaf);

  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const list = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.deactivatePlugin(${JSON.stringify(PROBE)});
    await rt.activatePlugin(list.find((m) => m.id === ${JSON.stringify(PROBE)}));
  })()`);
  await sleep(4000);
  const facts2 = await storeGet("facts");
  r.check("换一个 Worker 后取到新内容（no-store 在 Worker 路径上成立）", "leaf-v2", facts2?.leaf);
  r.check("新 Worker 的入口令牌与旧的同源可取回", true, /\?v=\d+/.test(String(facts2?.entryUrl)));

  r.group("⑤ 退出条件：todo 插件在 Worker 里跑通");
  await settings.invoke("permission_revoke", { pluginId: TODO });
  await sleep(1200);
  await writeEnabledIds(settings.invoke, [...new Set([...enabled, TODO])]);
  await setFlag(c, [PROBE, TODO]);
  await reloadAndWait(c);
  r.check(
    "todo 在 Worker 里 activate（badge 已挂载）",
    true,
    await waitUntil(
      c,
      `!!document.querySelector('#widget-badge div[data-plugin-id=${JSON.stringify(TODO)}]')`,
      60_000,
    ),
  );
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${TODO}:cmd`)}, { action: "add", text: "worker 里加的一条" }, ${JSON.stringify(TODO)});
  })()`);
  await sleep(2500);
  const tasks = (await invoke("store_get", { pluginId: TODO, key: "tasks" })).v ?? [];
  r.check("经 Worker 的存储写入落盘", 1, tasks.length);
  r.check("子模块 todo-txt.js 的解析在 Worker 里也成立", "worker 里加的一条", tasks[0]?.text);
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${TODO}:cmd`)}, { action: "remove", id: ${JSON.stringify(tasks[0]?.id ?? "")} }, ${JSON.stringify(TODO)});
  })()`);
  await sleep(1500);

  r.group("停用后回收");
  const sessionCount = await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const wh = await import('/src/runtime/worker-plugin-host.ts');
    await rt.deactivatePlugin(${JSON.stringify(TODO)});
    await rt.deactivatePlugin(${JSON.stringify(PROBE)});
    return wh.workerPluginHost.sessionCount;
  })()`);
  r.check("两个 Worker 会话都收掉了", 0, sessionCount);
  r.check("插件自己的 deactivate 在 Worker 里跑完", true, (await storeGet("deactivated")) === true);

  r.group("零噪音");
  r.info("导航过渡期告警", String(c.transitionNoise.length));
  r.check("无 console 错误与未捕获异常", [], c.noise);
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  stopped = true;
  if (settings) {
    await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
    await settings.invoke("permission_revoke", { pluginId: PROBE }).catch(() => undefined);
    await settings.invoke("permission_revoke", { pluginId: TODO }).catch(() => undefined);
    settings.close();
    settings = null;
  }
  if (cdp) {
    await cdp.ev(`localStorage.removeItem(${JSON.stringify(FLAG)})`).catch(() => undefined);
    await sleep(1200);
    await reloadAndWait(cdp).catch(() => undefined);
    await sleep(1200);
    cdp.close();
  }
  if (invoked) rmSync(INSTALLED, { recursive: true, force: true });
  const failed = r.summary();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
