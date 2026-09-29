// Agent 桥端到端断言：本机起一个假的状态端点冒充 petdex，验证示例插件
// com.pet.agent-bridge 真的把编码 Agent 的会话状态变成了宠物动作与台词。
//   终端 1: npm run dev:debug      终端 2: npm run verify:agent
// 与 verify-isolation 的分工：那条管隔离与安全规则，这条管 agent-bridge 的行为。
// petdex 真身跑起来时判据不变（假端点换成 7777 上的实例即可）。
import { createServer } from "node:http";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, listPages, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const AGENT_ID = "com.pet.agent-bridge";
const HOOK_PORT = Number(env.AGENT_STATE_PORT ?? 7777);
const ENABLED_KEY = "host:enabled-plugins";
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const r = createReport("Agent 桥端到端（dev）");

// --------------------------------------------------- 假的 petdex 状态端点
// 响应形状照抄 petdex hook_server 的 mirrorState / mirrorBubble，
// 否则这条断言验的就不是真契约。
let snap = { state: "idle", counter: 1, agent: "qoder", title: "verify", busy: false };
let endpoint = null;
let bubbleReads = 0;

function startEndpoint() {
  return new Promise((res, rej) => {
    endpoint = createServer((req, reply) => {
      const path = (req.url ?? "").split("?")[0];
      let body;
      if (path === "/state") body = JSON.stringify({ state: snap.state, counter: snap.counter });
      else if (path === "/bubble") {
        bubbleReads += 1;
        body = JSON.stringify({
          text: "正在改 src/main.ts",
          title: snap.title,
          agent_source: snap.agent,
          hostname: "localhost",
          busy: snap.busy,
          counter: snap.counter,
          at: Date.now(),
        });
      } else if (path === "/health") body = JSON.stringify({ ok: true, port: HOOK_PORT });
      else {
        reply.writeHead(404, { "content-type": "application/json" });
        reply.end('{"ok":false}');
        return;
      }
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(body);
    });
    endpoint.once("error", rej);
    endpoint.listen(HOOK_PORT, "127.0.0.1", res);
  });
}

function stopEndpoint() {
  endpoint?.close();
  endpoint = null;
}

/**
 * 授权只能走真实同意框（宿主没有直接放行的命令），且各能力的框是分批弹的
 * —— http 在首次轮询时，pet:react/pet:say 要等到第一次状态转移。
 * 所以后台持续应答整个测试期间，把每次看到的权限记下来供断言。
 * stop() 用于收尾：不能停晚一步，否则会把撤销之后的授权又点回来。
 */
function makeConsentPump(seen) {
  let stopped = false;
  const run = async (deadlineMs) => {
    const until = Date.now() + deadlineMs;
    while (!stopped && Date.now() < until) {
      const target = (await listPages(PORT)).find((t) => /consent/.test(t.url));
      if (!target) {
        await sleep(400);
        continue;
      }
      const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 10_000);
      try {
        seen.push(await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`));
        await cs.ev(`document.getElementById('btn-allow').click()`);
      } finally {
        cs.close();
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
  await startEndpoint();
  c = await attach(PORT, isPetPage);
  origEnabled = await c.ev(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)}) ?? '[]'`);
  const token = `agent-${Date.now()}`;
  const acts = () => c.ev(`window.__pet.acts.slice()`);
  const said = () => c.ev(`window.__pet.said.slice()`);
  const hasTopic = (expr) =>
    c.ev(`(window.__topics.slice().some(([k, p]) => ${expr}))`);

  r.group("启用插件");
  await c.ev(
    `(() => { const list = JSON.parse(${JSON.stringify(origEnabled)}); if (!list.includes(${JSON.stringify(AGENT_ID)})) list.push(${JSON.stringify(AGENT_ID)}); localStorage.setItem(${JSON.stringify(ENABLED_KEY)}, JSON.stringify(list)); return true; })()`,
  );
  await reloadAndWait(c);
  await c.ev(`window.__verifyToken = ${JSON.stringify(token)}; true`);
  pumpDone = consentPump.run(60_000);

  // 记录本体收到的动作与台词：气泡 DOM 3.6 秒就收起来，截在入口处更稳
  r.check(
    "宠物控制器可用",
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
      return true;
    })()`),
  );

  r.group("http 域名授权");
  snap = { ...snap, state: "running", counter: 2, busy: true };
  r.check("宠物收到 walk 动作", true, await waitUntil(c, `window.__pet.acts.includes('walk')`, 20_000));
  r.check(
    "同意框列出了 127.0.0.1 这个域名",
    true,
    grantedCaps.some((caps) => caps.some((x) => x.includes("127.0.0.1"))),
  );
  r.check("running 只动不作声", [], await said());

  r.group("needs_input → 好奇并说明是谁在等");
  snap = { ...snap, state: "needs_input", counter: 3, title: "改 main.ts" };
  r.check("宠物收到 curious", true, await waitUntil(c, `window.__pet.acts.includes('curious')`, 20_000));
  r.check(
    "台词带上了 agent 来源",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('qoder') && t.includes('确认'))`, 20_000),
  );
  r.check("确实读过 /bubble", true, bubbleReads >= 1);
  r.check(
    "气泡渲染进了 DOM",
    true,
    await waitUntil(c, `(document.getElementById('pet-bubble')?.textContent ?? '').includes('qoder')`, 5_000),
  );

  r.group("同一状态重复上报不再动");
  const before = (await acts()).length;
  snap = { ...snap, counter: 4 };
  await sleep(2400);
  r.check("acts 计数不变", before, (await acts()).length);

  r.group("端点消失 → 只播报一次，且不影响宿主");
  stopEndpoint();
  r.check(
    "播报过一次断开",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k, p]) => k === 'status' && (p.text ?? '').includes('已断开 petdex')))`, 20_000),
  );
  r.check("页面仍然活着", 2, await c.ev(`1+1`));
  const afterLost = (await acts()).length;
  await sleep(1600);
  r.check("断开期间没有多余动作", afterLost, (await acts()).length);
  const disconnects = await c.ev(
    `(window.__topics.slice().filter(([k, p]) => k === 'status' && (p.text ?? '').includes('已断开')).length)`,
  );
  r.check("断开只播了一次", 1, disconnects);

  r.group("端点回来 → 恢复跟随");
  await startEndpoint();
  snap = { ...snap, state: "failed", counter: 5 };
  r.check("宠物收到 angry", true, await waitUntil(c, `window.__pet.acts.includes('angry')`, 25_000));
  r.check("播报过一次重连", true, await hasTopic(`k === 'status' && (p.text ?? '').includes('已连上 petdex')`));
  r.check("状态 topic 带上了会话状态", true, await hasTopic(`k === 'state' && p.state === 'failed'`));

  r.group("收尾前的完整性");
  r.check("测试期间宠物窗未被重载", token, await c.ev(`window.__verifyToken ?? null`));
  await sleep(500); // console 事件异步送达
  r.check("零噪音", [], c.noise);
} finally {
  // 收尾顺序要紧：
  // 1. 先停同意框应答 —— 否则撤销之后插件的下一次轮询会又弹一个框，被后台应答点回授权。
  // 2. 再趁端点还活着把插件下线并重载 —— 反过来会留下在途请求或挂起的授权被重载打断，
  //    宿主随后把孤儿回调告警喷到页面上，污染下一次 verify 的零噪音断言。
  // 3. 最后关端点、撤销授权。
  consentPump.stop();
  await pumpDone?.catch(() => undefined);
  if (c) {
    const invoke = hostInvoke(c);
    if (origEnabled !== null) {
      // 走运行时下线，不要靠重载：重载会切断插件在途的 IPC，宿主把孤儿回调告警
      // 喷到页面上，而它留在文档的 console 缓冲里，会被下一次 attach 的客户端回放出来，
      // 表现为「主回归的零噪音偶发红」——看着像别人的问题，其实是我们留下的。
      await c
        .ev(`(async () => {
          const rt = await import('/src/runtime/plugin-runtime.ts');
          rt.setEnabledIds(JSON.parse(${JSON.stringify(origEnabled)}));
          await rt.deactivatePlugin(${JSON.stringify(AGENT_ID)});
          return true;
        })()`)
        .catch(() => undefined);
      await sleep(1500); // 让 deactivate 与在途请求落地，再拆端点
    }
    stopEndpoint();
    const revoked = await invoke("permission_revoke", { pluginId: AGENT_ID });
    r.info("已撤销授权", JSON.stringify(revoked.ok ? revoked.v : revoked.e));
    const left = await invoke("permission_list");
    r.info("剩余授权", JSON.stringify(left.ok ? left.v : left.e));
    // 最后换一个新文档：本跑期间产生的任何 console 输出都跟着旧文档一起丢掉，
    // 否则下一次 attach 的客户端（比如主回归）会把它当成自己跑出来的噪音。
    // 此刻插件已下线、同意框已停应答，属于「无在途请求的纯重载」，不会自己制造孤儿。
    await reloadAndWait(c).catch(() => undefined);
  }
  const failed = r.summary();
  c?.close();
  await sleep(500); // 等后台同意框连接与 websocket 关掉，否则 Node 退出时抛 UV_HANDLE_CLOSING
  process.exit(failed ? 1 : 0);
}
