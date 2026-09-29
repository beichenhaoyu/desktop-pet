// Agent 事件链路的端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:agent
// 覆盖两层：
//   1) hook 分支 —— 真的用 exe 跑一次 `--pet-hook <phase>`，验证 stdin 落成一行 JSONL；
//   2) 采集→归一化→宠物 —— 往收件目录追加事件，断言宠物动作、台词、总线 topic 与去重。
// 不依赖 petdex，也不需要 Qoder 真跑起来：事件是按其 hook 形状直接造的。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argv, env } from "node:process";
import { spawnSync } from "node:child_process";
import { attach, createReport, hostInvoke, listPages, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const AGENT_ID = "com.pet.agent-bridge";
const ENABLED_KEY = "host:enabled-plugins";
const EXE = join(import.meta.dirname, "../src-tauri/target/debug/desktop-pet.exe");
const INBOX = join(env.APPDATA ?? "", "com.desktoppet.pet", "agent", "inbox");
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const r = createReport("Agent 事件链路（dev）");

let seq = 0;
function emitPhase(phase, payload = {}) {
  const line = JSON.stringify({ phase, at: Date.now(), payload: { session_id: "verify-sess", ...payload } });
  appendFileSync(join(INBOX, `${phase}.jsonl`), line + "\n");
  return line;
}

/** 授权只能走真实同意框，且各能力的框分批弹，所以后台持续应答整个测试期间 */
function makeConsentPump(seen) {
  let stopped = false;
  const run = async (deadlineMs) => {
    const until = Date.now() + deadlineMs;
    while (!stopped && Date.now() < until) {
      const target = (await listPages(PORT).catch(() => []))
        .find((t) => /consent/.test(t.url));
      if (!target) {
        await sleep(250);
        continue;
      }
      // 单个框没答上不致命，但绝不能让异常把整个应答循环带走：
      // 一旦没人答后续对话框，宿主 60 秒超时就会把它们全判成「用户拒绝」，
      // 表现为偶发的「零噪音」红，而且红在离根因很远的断言上。
      try {
        const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
        try {
          seen.push(await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`));
          await cs.ev(`document.getElementById('btn-allow').click()`);
        } finally {
          cs.close();
        }
      } catch (e) {
        console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 80)}`);
      }
      await sleep(300);
    }
  };
  return { run, stop: () => (stopped = true) };
}

let c = null;
let origEnabled = null;
let pumpDone = null;
const grantedCaps = [];
const consentPump = makeConsentPump(grantedCaps);

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
  if (!existsSync(INBOX)) throw new Error(`收件目录不存在：${INBOX}（宿主没起来？）`);

  // ---------- 1) hook 分支：exe 收 stdin 并落盘 ----------
  r.group("hook 接收分支（起一个真实的 exe --pet-hook）");
  const marker = `hook-probe-${Date.now()}`;
  const before = (() => {
    try {
      return readFileSync(join(INBOX, "pre.jsonl"), "utf8").length;
    } catch {
      return 0;
    }
  })();
  const spawned = spawnSync(EXE, ["--pet-hook", "pre"], {
    input: JSON.stringify({ session_id: marker, tool_name: "Edit" }),
    encoding: "utf8",
    timeout: 15_000,
  });
  r.check("hook 分支退出码为 0", 0, spawned.status);
  const after = (() => {
    try {
      return readFileSync(join(INBOX, "pre.jsonl"), "utf8");
    } catch {
      return "";
    }
  })();
  const appended = after.slice(before).trim().split("\n").filter(Boolean);
  r.check("落盘且只有一行", 1, appended.length);
  const landed = appended.length ? JSON.parse(appended[0]) : {};
  r.check("phase 与 session 正确", [ "pre", marker ], [ landed.phase, landed.payload?.session_id ]);
  const bogus = spawnSync(EXE, ["--pet-hook", "../escape"], { input: "{}", timeout: 15_000 });
  r.check("白名单外的 phase 被拒绝且没建文件", false, existsSync(join(INBOX, "escape.jsonl")) && bogus.status === 0);

  // 清场：上面那些会话会在宿主的活跃表里挂 90 秒，不把总状态压回 idle 的话，
  // 后面「第一个事件应该变 running」这类断言会因为起点就已经是 running 而假失败。
  emitPhase("session-end", { session_id: marker });
  emitPhase("session-end", { session_id: "verify-sess" });
  await sleep(1800); // 等 watcher 把这两条吃掉，总状态落回 idle 再往下测

  // ---------- 2) 采集 → 归一化 → 宠物 ----------
  c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(c);
  origEnabled = await c.ev(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)}) ?? '[]'`);
  const token = `agent-${Date.now()}`;
  await c.ev(`window.__verifyToken = ${JSON.stringify(token)}; true`);
  pumpDone = consentPump.run(240_000); // 宿主对同意框有 60 秒超时即视为拒绝，应答窗口必须比整轮测试更长

  r.group("启用插件");
  // 经运行时启停，不靠重载：重载会切断页面在途的 IPC（点击穿透每 250ms 问一次光标位置），
  // 宿主随后把「孤儿回调」告警喷到页面上，被后面的零噪音断言算作本跑噪音
  r.check(
    "插件经运行时激活",
    true,
    await c.ev(`(async () => {
      const rt = await import('/src/runtime/plugin-runtime.ts');
      const manifests = await window.__TAURI_INTERNALS__.invoke('plugins_list');
      const manifest = manifests.find((m) => m.id === ${JSON.stringify(AGENT_ID)});
      if (!manifest) throw new Error('宿主没扫到插件');
      rt.setEnabledIds([...JSON.parse(${JSON.stringify(origEnabled)}), ${JSON.stringify(AGENT_ID)}]);
      await rt.activatePlugin(manifest);
      return rt.isActive(${JSON.stringify(AGENT_ID)});
    })()`),
  );

  // 截获本体入口：气泡 DOM 3.6 秒就收起来，记在入口处更稳
  r.check(
    "宠物控制器可截获",
    true,
    await c.ev(`(async () => {
      const host = await import('/src/pet/host.ts');
      const ctrl = host.petController();
      if (!ctrl) return false;
      window.__pet = { acts: [], said: [] };
      const react0 = ctrl.react.bind(ctrl);
      const say0 = ctrl.say.bind(ctrl);
      ctrl.react = (a) => { window.__pet.acts.push(a); return react0(a); };
      ctrl.say = (t) => { window.__pet.said.push(t); return say0(t); };
      const { bus } = await import('/src/runtime/event-bus.ts');
      window.__topics = [];
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:state`)}, (p) => window.__topics.push(['state', p]));
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:status`)}, (p) => window.__topics.push(['status', p]));
      bus.subscribe("agent:state", (p) => window.__topics.push(['host-state', p]));
      return true;
    })()`),
  );
  const acts = () => c.ev(`window.__pet.acts.slice()`);
  const said = () => c.ev(`window.__pet.said.slice()`);

  /**
   * 等某个能力真的被授权。插件在 activate 时第一次 publish、第一次 react 各自会弹一个
   * 同意框，不先等它们落定就把首个事件发出去，断言测的其实是「应答对话框有多快」。
   */
  async function awaitGranted(cap, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const list = await invoke("permission_list");
      if (list.ok && (list.v[AGENT_ID] ?? []).includes(cap)) return true;
      await sleep(500);
    }
    return false;
  }

  r.group("插件上线与授权");
  r.check("总线授权已就位（activate 时的首次发布）", true, await awaitGranted("bus:publish"));

  r.group("插件不再需要任何网络能力");
  const manifests = await invoke("plugins_list");
  const manifest = manifests.ok ? manifests.v.find((m) => m.id === AGENT_ID) : null;
  r.check("manifest 存在", true, !!manifest);
  r.check("permissions 里没有 http", false, (manifest?.permissions ?? []).includes("http"));

  r.group("running：工具调用 → 走起来");
  emitPhase("pre", { tool_name: "Bash" });
  r.check("首次插播动作触发授权", true, await awaitGranted("pet:react", 30_000));
  r.check("宠物收到 walk", true, await waitUntil(c, `window.__pet.acts.includes('walk')`, 8_000));
  r.check("walk 时不作声", [], await said());
  r.check(
    "宿主广播了 agent:state=running",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-state' && p.state === 'running'))`, 5_000),
  );

  r.group("连续事件不重复插播");
  const beforeBurst = (await acts()).length;
  for (const [phase, payload] of [["post", { tool_name: "Bash" }], ["pre", { tool_name: "Read" }], ["post", { tool_name: "Read" }]]) {
    emitPhase(phase, payload);
    await sleep(300);
  }
  await sleep(1500);
  r.check("总状态没变就不该再动", beforeBurst, (await acts()).length);

  r.group("needs_input：等确认 → 好奇 + 说话");
  emitPhase("approval-request", { tool_name: "Bash" });
  r.check("宠物收到 curious", true, await waitUntil(c, `window.__pet.acts.includes('curious')`, 15_000));
  r.check(
    "台词提示需要确认",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('确认'))`, 15_000),
  );

  r.group("completed：一轮结束 → 打招呼");
  emitPhase("stop", {});
  r.check("宠物收到 greet", true, await waitUntil(c, `window.__pet.acts.includes('greet')`, 15_000));

  r.group("failed：工具失败 → 生气并带上工具名");
  emitPhase("tool-failure", { tool_name: "cargo test" });
  r.check("宠物收到 angry", true, await waitUntil(c, `window.__pet.acts.includes('angry')`, 15_000));
  r.check(
    "台词里带上失败的工具",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('cargo test'))`, 15_000),
  );

  r.group("会话结束后回落 idle");
  emitPhase("session-end", { session_id: "verify-sess" });
  r.check(
    "宿主广播了 idle",
    true,
    await waitUntil(c, `(window.__topics.slice().reverse().some(([k,p]) => k === 'host-state' && p.state === 'idle'))`, 25_000),
  );

  r.group("hook 命令写的是真实用户配置吗");
  const status = await invoke("agent_hooks_status");
  r.check("非设置窗调用被拒", false, status.ok);
  r.info("拒绝原因", String(status.e ?? "").slice(0, 60));

  r.group("收尾前的完整性");
  r.check("测试期间宠物窗未被重载", token, await c.ev(`window.__verifyToken ?? null`));
  await sleep(500); // console 事件异步送达
  r.check("零噪音", [], c.noise);
} finally {
  // 收尾顺序：停同意框应答 → 趁一切还在把插件下线（不要拿重载当下线手段）→ 撤销授权
  // → 最后重载换新文档，把本跑的 console 输出连同旧文档一起丢掉，别污染下一次 attach
  consentPump.stop();
  await pumpDone?.catch(() => undefined);
  if (c) {
    const invoke = hostInvoke(c);
    if (origEnabled !== null) {
      await c
        .ev(`(async () => {
          const rt = await import('/src/runtime/plugin-runtime.ts');
          rt.setEnabledIds(JSON.parse(${JSON.stringify(origEnabled)}));
          await rt.deactivatePlugin(${JSON.stringify(AGENT_ID)});
          return true;
        })()`)
        .catch(() => undefined);
      await sleep(1200);
    }
    const revoked = await invoke("permission_revoke", { pluginId: AGENT_ID });
    r.info("已撤销授权", JSON.stringify(revoked.ok ? revoked.v : revoked.e));
    await reloadAndWait(c).catch(() => undefined);
    // 等这一轮的收尾彻底落地再退出：下一套断言脚本紧跟着 attach 的话，
    // 会撞在这次重载的尾巴上，红在一堆与本跑无关的断言上
    await waitUntil(c, `!!window.__TAURI_INTERNALS__ && !!document.querySelector('#pet-canvas')`, 10_000);
    await sleep(1200);
  }
  const failed = r.summary();
  c?.close();
  await sleep(500);
  process.exit(failed ? 1 : 0);
}
