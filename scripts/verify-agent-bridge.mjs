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
import { attach, createReport, hostInvoke, listPages, openSettingsInvoker, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const AGENT_ID = "com.pet.agent-bridge";
const ENABLED_KEY = "host:enabled-plugins";
const EXE = join(import.meta.dirname, "../src-tauri/target/debug/desktop-pet.exe");
// 没有 APPDATA 就拼不出收件目录，断言会打在 cwd 下一个同名相对路径上 ——
// 那种失败和「宿主真的没收到事件」长得一模一样，必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：找不到宿主收件目录，拒绝开跑。");
  process.exit(2);
}
const INBOX = join(env.APPDATA, "com.desktoppet.pet", "agent", "inbox");
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
let settings = null;
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
  // 清场：把收件目录里出现过的**所有**会话都结束掉。
  // 装了 hook 之后这台机器是活的 —— 跑这条断言的 agent 自己每次工具调用都在写
  // pre/post，宿主的总状态会一直停在 running，「第一个事件应当变 running」就永远不成立。
  // 脚本运行期间不再有新事件进来（下一次工具调用要等脚本跑完），所以清完就能拿到干净起点。
  for (const phase of ["user-prompt", "pre", "post", "stop", "approval-request"]) {
    let text = "";
    try {
      text = readFileSync(join(INBOX, `${phase}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const id of new Set([...text.matchAll(/"session_id":"([^"]+)"/g)].map((m) => m[1]))) {
      appendFileSync(
        join(INBOX, "session-end.jsonl"),
        JSON.stringify({ phase: "session-end", at: Date.now(), payload: { session_id: id } }) + "\n",
      );
    }
  }
  await sleep(2500); // 等 watcher 把这些结束事件吃掉
  emitPhase("session-end", { session_id: "verify-sess" });
  await sleep(1800); // 等 watcher 把这两条吃掉，总状态落回 idle 再往下测

  // ---------- 2) 采集 → 归一化 → 宠物 ----------
  c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(c);
  origEnabled = await c.ev(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)}) ?? '[]'`);
  const token = `agent-${Date.now()}`;
  await c.ev(`window.__verifyToken = ${JSON.stringify(token)}; true`);
  pumpDone = consentPump.run(600_000); // 应答窗口必须比整轮长：宿主对同意框有 60 秒超时即视为拒绝 // 宿主对同意框有 60 秒超时即视为拒绝，应答窗口必须比整轮测试更长

  /** 本插件那扇悬浮窗：标签 overlay-<id>，但 Tauri 不允许点号，id 里的点被编码成 `_`
   *  （与 Rust 的 overlay_label 同式：id 词表里没有下划线，所以这是一一对应）；
   *  标题带原 id，用来在 CDP 里认出是哪一扇 */
  const overlayLabelFor = (id) => `overlay-${id.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const OVERLAY_LABEL = overlayLabelFor(AGENT_ID);
  const OVERLAY_TITLE = `DesktopPet Overlay · ${AGENT_ID}`;
  const findOverlayTarget = async () =>
    (await listPages(PORT).catch(() => [])).find(
      (t) => /overlay\.html/.test(t.url) && t.title === OVERLAY_TITLE,
    );

  /**
   * overlay 窗里是否挂上了本插件的容器。
   * widget 渲染在 closed Shadow DOM 里，外部选择器穿不进去（那是隔离设计的一部分），
   * 所以这里只断言到「挂上了没有」；卡片内容的正确性由下发给 widget 的数据断言保证。
   */
  async function overlayMounted(timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const target = await findOverlayTarget();
      if (target) {
        const oc = await attach(
          PORT,
          (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl,
          8_000,
        ).catch(() => null);
        if (oc) {
          try {
            const has = await oc.ev(
              `!!document.querySelector('#widget-overlay [data-plugin-id=${JSON.stringify(AGENT_ID)}][data-region="overlay"]')`,
            );
            if (has) return true;
          } finally {
            oc.close();
          }
        }
      }
      await sleep(600);
    }
    return false;
  }

  /** 在 overlay 窗里跑一段求值；窗不存在返回 null */
  async function withOverlayPage(fn) {
    const target = await findOverlayTarget();
    if (!target) return null;
    const oc = await attach(
      PORT,
      (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl,
      8_000,
    ).catch(() => null);
    if (!oc) return null;
    try {
      return await fn(oc);
    } finally {
      oc.close();
    }
  }

  async function overlayVisible(want, timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await invoke("plugin:window|is_visible", { label: OVERLAY_LABEL });
      if (v.ok && v.v === want) return true;
      await sleep(500);
    }
    return false;
  }

  /** 最近一次下发给卡片的数据（隐私开关的强度就体现在这里） */
  async function lastCard() {
    const all = await c.ev(`window.__topics.slice().filter(([k]) => k === 'card').map(([,p]) => p)`);
    return all.length ? all[all.length - 1] : null;
  }

  /** 模拟设置面板里的隐私开关：走插件自己的 cmd topic */
  async function setCardConfig(showTitle, showDetail) {
    await c.ev(`(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      bus.publish(${JSON.stringify(`${AGENT_ID}:cmd`)}, {
        action: 'config',
        showTitle: ${showTitle},
        showDetail: ${showDetail},
      });
      return true;
    })()`);
    await sleep(1200);
  }

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
      bus.subscribe('agent:event', (p) => window.__topics.push(['host-event', p]));
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:widget`)}, (p) => window.__topics.push(['card', p]));
      return true;
    })()`),
  );
  const acts = () => c.ev(`window.__pet.acts.slice()`);
  const said = () => c.ev(`window.__pet.said.slice()`);

  /**
   * 等某个能力真的被授权。插件在 activate 时第一次 publish、第一次 react 各自会弹一个
   * 同意框，不先等它们落定就把首个事件发出去，断言测的其实是「应答对话框有多快」。
   * 授权表只认设置窗（见 gate.rs），所以这份查询走设置页；宠物窗问同样的命令必须被拒。
   */
  async function awaitGranted(cap, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const list = await settings.invoke("permission_list");
      if (list.ok && (list.v[AGENT_ID] ?? []).includes(cap)) return true;
      await sleep(500);
    }
    return false;
  }

  r.group("插件上线与授权");
  // 撤销授权、读授权表都是「只认设置窗」的命令，先把设置窗唤出来
  settings = await openSettingsInvoker(PORT, c);
  const fromPet = await invoke("permission_list");
  r.check("宠物窗读授权表被门禁拒绝", true, !fromPet.ok && /设置窗/.test(String(fromPet.e)));
  r.check("总线授权已就位（activate 时的首次发布）", true, await awaitGranted("bus:publish"));

  r.group("插件不再需要任何网络能力");
  const manifests = await invoke("plugins_list");
  const manifest = manifests.ok ? manifests.v.find((m) => m.id === AGENT_ID) : null;
  r.check("manifest 存在", true, !!manifest);
  r.check("permissions 里没有 http", false, (manifest?.permissions ?? []).includes("http"));

  r.group("running：工具调用 → petdex 的 running");
  emitPhase("pre", { tool_name: "Bash" });
  r.check("首次插播状态触发授权", true, await awaitGranted("pet:react", 30_000));
  r.check("宠物收到 running", true, await waitUntil(c, `window.__pet.acts.includes('running')`, 8_000));
  r.check("running 时不作声", [], await said());
  r.check(
    "宿主广播了 agent:state=running",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-state' && p.state === 'running'))`, 5_000),
  );

  r.group("细粒度：只读工具走 review，工具间隙不闪回 idle");
  const beforeBurst = (await acts()).length;
  for (const [phase, payload] of [["post", { tool_name: "Bash" }], ["pre", { tool_name: "Read" }], ["post", { tool_name: "Read" }]]) {
    emitPhase(phase, payload);
    await sleep(300);
  }
  await sleep(1500);
  const burst = (await acts()).slice(beforeBurst);
  r.check("Read 这类只读工具切到 review", true, burst.includes("review"));
  r.check("会话还在跑时 post 不把姿势打回 idle", false, burst.includes("idle"));

  r.group("needs_input：等确认 → waiting + 说话");
  emitPhase("approval-request", { tool_name: "Bash" });
  r.check("宠物收到 waiting", true, await waitUntil(c, `window.__pet.acts.includes('waiting')`, 15_000));
  r.check(
    "台词提示需要确认",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('确认'))`, 15_000),
  );

  r.group("completed：一轮结束 → waving");
  emitPhase("stop", {});
  r.check("宠物收到 waving", true, await waitUntil(c, `window.__pet.acts.includes('waving')`, 15_000));

  r.group("一轮结束：迟到的 post 不再打开，卡片 3 秒自动收起");
  emitPhase("post", { tool_name: "Bash" }); // 比 stop 晚到，属于常态
  await sleep(2000);
  r.check(
    "总状态仍是这轮完成",
    "completed",
    await c.ev(`(window.__topics.slice().reverse().find(([k]) => k === 'host-state')?.[1].state ?? '')`),
  );
  r.check("卡片 3 秒后自动收起", true, await overlayVisible(false, 9_000));

  r.group("failed：工具失败 → petdex 的 failed 并带上工具名");
  emitPhase("tool-failure", { tool_name: "cargo test" });
  r.check("宠物收到 failed", true, await waitUntil(c, `window.__pet.acts.includes('failed')`, 15_000));
  r.check(
    "台词里带上失败的工具",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('cargo test'))`, 15_000),
  );

  r.group("状态卡：开关关闭时不下发敏感内容");
  // 显式关掉开关再验：插件的开关状态是持久化的，上一轮被中途 kill 会留下「开着」的状态，
  // 依赖环境干净等于把断言变成随机
  await setCardConfig(false, false);
  const SECRET_TITLE = "把内部口令 abc123 写进配置";
  const SECRET_CMD = "echo abc123-inner-secret";
  emitPhase("user-prompt", { prompt: SECRET_TITLE });
  emitPhase("pre", { tool_name: "Bash", tool_input: { command: SECRET_CMD } });
  r.check(
    "宿主 agent:event 带上命令摘要",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-event' && (p.detail ?? '').includes('abc123-inner')))`, 12_000),
  );
  r.check(
    "宿主 agent:event 带上步数",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-event' && p.steps >= 1))`, 12_000),
  );
  r.check("会话进行中悬浮卡可见", true, await overlayVisible(true));
  r.check("卡片 widget 挂进 overlay 区", true, await overlayMounted());

  r.group("两扇悬浮窗互不抢占：左上角波形与头顶卡片可以同时存在");
  const HR_ID = "com.pet.hr-ble";
  const HR_LABEL = overlayLabelFor(HR_ID);
  // 直接打宿主命令：验的是「窗口按插件分开」这条宿主规则本身，不依赖蓝牙硬件
  await invoke("overlay_show", { pluginId: HR_ID, placement: "corner", height: 200 });
  r.check(
    "两张卡片同时可见",
    true,
    await waitUntil(
      c,
      `(async () => {
        const l = await window.__TAURI_INTERNALS__.invoke('overlay_list');
        const on = (id) => l.some(([p, v]) => p === id && v);
        return on(${JSON.stringify(AGENT_ID)}) && on(${JSON.stringify(HR_ID)});
      })()`,
      12_000,
    ),
  );
  const posAgent = await invoke("plugin:window|outer_position", { label: OVERLAY_LABEL });
  const posHr = await invoke("plugin:window|outer_position", { label: HR_LABEL });
  r.check("心率那扇留在桌面左上角", true, (posHr.v?.x ?? 1e9) < 150 && (posHr.v?.y ?? 1e9) < 150);
  r.check(
    "两扇窗的位置不是同一个点",
    true,
    JSON.stringify(posAgent.v) !== JSON.stringify(posHr.v),
  );
  await invoke("overlay_destroy", { pluginId: HR_ID });
  r.check("销毁只收掉那一扇，状态卡不受影响", true, await overlayVisible(true, 8_000));
  // 位置用 window.screenX/outerHeight 比较：两个窗都在同一 DPI 下，且不需要额外 capability
  const petGeo = await c.ev(`[window.screenX, window.screenY, window.outerWidth, window.outerHeight]`);
  const cardGeo = await withOverlayPage((oc) => oc.ev(`[window.screenX, window.screenY, window.outerWidth, window.outerHeight]`));
  const centered = cardGeo && Math.abs(cardGeo[0] + cardGeo[2] / 2 - (petGeo[0] + petGeo[2] / 2)) < 60;
  r.check(
    "卡片贴在宠物正上方（而不是左上角）",
    true,
    !!cardGeo && cardGeo[1] + cardGeo[3] <= petGeo[1] + 4 && centered,
  );
  r.check("卡片宽度明显小于左上角整屏", true, !!cardGeo && cardGeo[2] <= 360);

  r.group("游戏模式隐身时卡片一起收，恢复后按会话状态回来");
  await invoke("set_pet_hidden", { hidden: true });
  r.check("隐身时卡片一起收掉", true, await overlayVisible(false, 8_000));
  await invoke("set_pet_hidden", { hidden: false });
  r.check("恢复后卡片按当前会话状态回来", true, await overlayVisible(true, 8_000));
  const cardOff = await lastCard();
  r.check("卡片数据含执行中状态", "running", cardOff?.state);
  r.check("卡片数据含中文标签", "正在执行", cardOff?.label);
  r.check("卡片数据含工具名", "Bash", cardOff?.toolName);
  r.check("卡片步数至少 1", true, (cardOff?.steps ?? 0) >= 1);
  r.check("默认不下发会话标题", "", cardOff?.title);
  r.check("默认不下发命令内容", "", cardOff?.detail);

  r.group("状态卡：开关打开后才下发敏感内容");
  await setCardConfig(true, true);
  const cardOn = await lastCard();
  r.check("打开后下发会话标题", true, (cardOn?.title ?? "").includes("把内部口令 abc123"));
  r.check("打开后下发命令摘要", true, (cardOn?.detail ?? "").includes("echo abc123-inner-secret"));
  // 面板重新挂载时靠这份回灌数据回显；没有它就会显示成默认值，表现成「配置没保存」
  const echoed = await invoke("bus_peek", { topic: `${AGENT_ID}:widget` });
  r.check(
    "宿主为面板回灌最近一份卡片数据（含已保存的开关）",
    true,
    echoed.v?.showTitle === true && echoed.v?.showDetail === true,
  );
  await setCardConfig(false, false);
  const cardOff2 = await lastCard();
  r.check("关掉后又变回空", true, (cardOff2?.title ?? "x") === "" && (cardOff2?.detail ?? "x") === "");

  r.group("会话结束后回落 idle");
  emitPhase("session-end", { session_id: "verify-sess" });
  r.check(
    "宿主广播了 idle",
    true,
    await waitUntil(c, `(window.__topics.slice().reverse().some(([k,p]) => k === 'host-state' && p.state === 'idle'))`, 25_000),
  );
  r.check("会话结束后悬浮卡收起", true, await overlayVisible(false, 15_000));

  r.group("hook 命令的调用面：宠物窗被拒，宿主路径（设置窗）放行");
  const status = await invoke("agent_hooks_status");
  r.check("宠物窗（主 realm）调用被拒", false, status.ok);
  r.info("拒绝原因", String(status.e ?? "").slice(0, 60));
  // B2 迁移：声明 agent:hooks 的插件设置页（settings 区）经能力校验后才放行 ——
  // 那条链路（同意框、badge/overlay 区取不到 host、撤销两分支）在 verify-isolation 里断言；
  // 这里钉住反向：从宠物窗绕过桥直接 invoke，带不带 pluginId 都被窗口门禁挡住。
  const petInstall = await invoke("agent_hooks_install", { pluginId: AGENT_ID });
  r.check("宠物窗带 pluginId 直接 invoke install 也被拒（label 决定，不是能力决定）", false, petInstall.ok);
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  const hostStatus = await settings.invoke("agent_hooks_status");
  r.check("宿主路径（设置窗、不带 pluginId）照旧可用", true, hostStatus.ok === true);
  r.check("宿主 status 回显含配置文件列表", true, Array.isArray(hostStatus.v?.files));

  r.group("收尾前的完整性");
  r.check("测试期间宠物窗未被重载", token, await c.ev(`window.__verifyToken ?? null`));
  await sleep(500); // console 事件异步送达
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(c.transitionNoise.length));
  r.check("零噪音", [], c.noise);
} catch (err) {
  // 断言中途抛错绝不能以 0 收场：对回归工具来说，「崩了但退出码 0」比一条红断言危险得多
  r.check("脚本未抛异常", true, false);
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  // 收尾顺序：停同意框应答 → 趁一切还在把插件下线（不要拿重载当下线手段）→ 撤销授权
  // → 最后重载换新文档，把本跑的 console 输出连同旧文档一起丢掉，别污染下一次 attach
  consentPump.stop();
  await pumpDone?.catch(() => undefined);
  if (c) {
    const wasEnabled = origEnabled !== null && JSON.parse(origEnabled).includes(AGENT_ID);
    if (origEnabled !== null) {
      // 原样恢复用户那份清单。先前这里会把 agent-bridge 从清单里摘掉，
      // 用户本来开着它，跑完一轮回归它就悄悄下线了
      await c
        .ev(`(async () => {
          const rt = await import('/src/runtime/plugin-runtime.ts');
          rt.setEnabledIds(JSON.parse(${JSON.stringify(origEnabled)}));
          ${wasEnabled ? "" : `await rt.deactivatePlugin(${JSON.stringify(AGENT_ID)});`}
          return true;
        })()`)
        .catch(() => undefined);
      await sleep(1200);
    }
    if (!wasEnabled) {
      // 只撤销本跑自己申请到的授权；撤销只认设置窗，所以走那一页的命令通道
      if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
      const revoked = settings
        ? await settings.invoke("permission_revoke", { pluginId: AGENT_ID })
        : { ok: false, e: "设置窗没开起来，授权留在原地" };
      r.info("已撤销授权", JSON.stringify(revoked.ok ? revoked.v : revoked.e));
    } else {
      r.info("用户本来就开着它", "授权与启用清单原样保留");
    }
    settings?.close();
    settings = null;
    await reloadAndWait(c).catch(() => undefined);
    // 等这一轮的收尾彻底落地再退出：下一套断言脚本紧跟着 attach 的话，
    // 会撞在这次重载的尾巴上，红在一堆与本跑无关的断言上
    await waitUntil(c, `!!window.__TAURI_INTERNALS__ && !!document.querySelector('#pet-canvas')`, 10_000);
    await sleep(1200);
  } else {
    settings?.close();
  }
  const failed = r.summary();
  c?.close();
  await sleep(500);
  process.exit(failed ? 1 : 0);
}
