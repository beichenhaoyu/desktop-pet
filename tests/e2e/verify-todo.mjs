// 待办插件端到端断言：解析、落盘、广播、桌面卡片、回显、撤销清理。
//   终端 1: npm run dev:debug      终端 2: npm run verify:todo
// 会真的弹同意框并持续应答（授权只能走真实同意框），跑完撤销授权并下线插件。
import { argv, env } from "node:process";
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
const PID = "todo";
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("待办插件（dev）");

const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const FUTURE = `2099-01-01`;

let stopped = false;
/** 同意框是逐个能力分批弹的，必须整轮持续应答；单框没答上会被宿主 60 秒判成拒绝 */
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
let origEnabled = [];
let cdp;
let settings = null;

try {
  c = await attach(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
  cdp = c;
  const invoke = hostInvoke(c);
  origEnabled = await readEnabledIds(invoke);
  void pump(420_000);

  r.group("发现与激活");
  const manifest = (await invoke("plugins_list")).v?.find((m) => m.id === PID);
  r.check("manifest 被发现", true, !!manifest);
  r.check(
    "订阅 API 需要的能力已声明",
    true,
    (manifest?.permissions ?? []).includes("bus:subscribe"),
  );
  // 从干净状态开始：撤销授权会连带清掉插件存储目录。
  // 撤销与查看授权表只认设置窗（插件 JS 就跑在宠物窗里，不设门禁的话它一行 invoke
  // 就能抹掉任意插件的授权并清掉其存储），所以这里走设置页的命令通道。
  settings = await openSettingsInvoker(PORT, c);
  const fromPet = await invoke("permission_revoke", { pluginId: PID });
  r.check("宠物窗撤销授权被门禁拒绝", true, !fromPet.ok && /设置窗/.test(String(fromPet.e)));
  await settings.invoke("permission_revoke", { pluginId: PID });
  // 等 Rust 把删目录的异步操作做完再重载：否则在飞的 IPC 回调会被 reload 打断，
  // WebView2 会报「custom protocol failed / 找不到 callback id」，混进零噪音断言里
  await sleep(1500);
  // 启停清单归宿主（C1）：写从设置窗走，宠物窗调用会被门禁拒
  await writeEnabledIds(settings.invoke, [...origEnabled, PID]);
  await reloadAndWait(c);
  await sleep(5000);

  r.check("badge 已挂载", true, await waitUntil(
    c,
    `!!document.querySelector('#widget-badge div[data-plugin-id=${JSON.stringify(PID)}]')`,
    25_000,
  ));
  r.check(
    "插件确实订阅了自己的 cmd topic",
    true,
    await c.ev(`(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      return (bus.handlers.get(${JSON.stringify(`${PID}:cmd`)})?.size ?? 0) > 0;
    })()`),
  );

  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    // 中继那侧现在按 pluginId 认 topic 归属（见 commands/bus.rs 的 S2 门禁）：
    // 脚本模拟的是插件自己发指令，统一绑上 PID
    window.__bus = { publish: (topic, payload) => bus.publish(topic, payload, ${JSON.stringify(PID)}) };
    window.__seen = [];
    for (const k of ['changed', 'status', 'widget']) {
      bus.subscribe(${JSON.stringify(`${PID}:`)} + k, (p) => window.__seen.push([k, p]));
    }
  })()`);

  const send = async (cmd) => {
    await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify(cmd)})`);
    await sleep(1200);
  };
  const tasks = async () => (await invoke("store_get", { pluginId: PID, key: "tasks" })).v ?? [];

  r.group("todo.txt 字段解析与落盘");
  // 优先级标记只能在行首，写成「写周报 (A)」是不合法的输入，解析器会当它是正文
  await send({ action: "add", text: `(A) 写周报 due:${TODAY} @工作 +老板` });
  await send({ action: "add", text: "买牛奶" });
  const added = await tasks();
  r.check("两条都已落盘", 2, added.length);
  const report = added.find((t) => t.text === "写周报");
  r.check("优先级从行首剥出来", "A", report?.priority);
  r.check("due 进 meta", TODAY, report?.meta?.due);
  r.check("@项目 归位", ["工作"], report?.projects);
  r.check("+上下文 归位", ["老板"], report?.contexts);
  r.check("项目与上下文不留在正文里", true, !/[+@]/.test(report?.text ?? ""));
  r.check("没 due 的那条 meta 为空", true, !(added.find((t) => t.text === "买牛奶")?.meta?.due));

  r.group("标准 topic 广播");
  const changed = (await c.ev(`window.__seen.filter(([k]) => k === 'changed').map(([,p]) => p)`)).at(-1);
  r.check("todo:changed 带未完成数", 2, changed?.open);
  r.check("next 是按 due 排序的那条", true, (changed?.nextDue ?? "") === TODAY);

  r.group("界面数据");
  r.check(
    "今天到期的那条被算进未完成",
    true,
    (await c.ev(`window.__seen.filter(([k]) => k === 'widget').map(([,p]) => p).at(-1)?.openCount`)) === 2,
  );

  r.group("桌面卡片：本插件单独一扇窗");
  await send({ action: "config", card: true });
  r.check(
    "overlay-todo 可见",
    true,
    await waitUntil(
      c,
      `(async () => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-${PID}' })) === true)()`,
      15_000,
    ),
  );
  const cardTarget = (await listPages(PORT)).find(
    (t) => /overlay\.html/.test(t.url) && t.title === `DesktopPet Overlay · ${PID}`,
  );
  r.check("卡片页按标题能被认出来", true, !!cardTarget);
  const cardMounted = cardTarget
    ? await (async () => {
        const oc = await attach(PORT, (t) => t.webSocketDebuggerUrl === cardTarget.webSocketDebuggerUrl, 10_000);
        try {
          return await oc.ev(
            `!!document.querySelector('#widget-overlay div[data-plugin-id=${JSON.stringify(PID)}]')`,
          );
        } finally {
          oc.close();
        }
      })()
    : false;
  r.check("卡片 widget 挂进 overlay 区", true, cardMounted);

  r.group("设置面板回显当前配置");
  const peeked = await invoke("bus_peek", { topic: `${PID}:widget` });
  r.check("回灌的数据带着 card 开关", true, peeked.v?.config?.card === true);
  r.check("回灌的数据带着清单", 2, (peeked.v?.tasks ?? []).length);

  r.group("勾选完成与删除");
  const first = (await tasks())[0];
  await send({ action: "toggle", id: first.id, done: true });
  const afterToggle = await tasks();
  const done = afterToggle.find((t) => t.id === first.id);
  r.check("标记为已完成", true, done?.done === true);
  r.check("补上完成日期", TODAY, done?.completed);
  r.check(
    "完成项不再出现在未完成清单里",
    1,
    (await c.ev(`window.__seen.filter(([k]) => k === 'widget').map(([,p]) => p).at(-1)?.openCount`)),
  );
  await send({ action: "clearDone" });
  r.check("清掉已完成后只剩一条", 1, (await tasks()).length);
  const rest = (await tasks())[0];
  await send({ action: "remove", id: rest.id });
  r.check("删空", 0, (await tasks()).length);
  await send({ action: "config", card: false });
  r.check(
    "关掉开关后卡片收起",
    true,
    await waitUntil(
      c,
      `(async () => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-${PID}' })) === false)()`,
      12_000,
    ),
  );

  r.group("订阅方拿到的「下一个到期」真的是最近的");
  // 此刻清单是空的，正好只放两条「都还没到期」的：它们 dueRank 相同（都是将来），
  // 只按档位 + 优先级排的话，先加的 12 月会挡在前面，nextDue 报出的是一个更晚的日子
  const NEAR = `${d.getFullYear() + 1}-03-05`;
  const FAR = `${d.getFullYear() + 1}-06-25`;
  await send({ action: "add", text: `年终盘点 due:${FAR}` });
  await send({ action: "add", text: `春季冲刺 due:${NEAR}` });
  const ordered = (await c.ev(`window.__seen.filter(([k]) => k === 'changed').map(([,p]) => p)`)).at(-1);
  r.check("先加的远期不该成为「下一个到期」", NEAR, ordered?.nextDue);
  const cardView = (await c.ev(`window.__seen.filter(([k]) => k === 'widget').map(([,p]) => p)`)).at(-1);
  r.check("卡片清单第一条就是最近到期的那条", true, cardView?.tasks?.[0]?.meta?.due === NEAR);
  for (const t of await tasks()) await send({ action: "remove", id: t.id });

  r.group("未来到期日不参与提醒");
  await send({ action: "add", text: `明年再说 due:${FUTURE}` });
  const future = (await tasks())[0];
  r.check("存下来的是原样", FUTURE, future?.meta?.due);
  await send({ action: "remove", id: future.id });

  r.group("零噪音");
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(c.transitionNoise.length));
  r.check("无 console 错误与未捕获异常", [], c.noise);
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  stopped = true;
  if (cdp) {
    // 下线插件 + 撤销授权（撤销会连带清掉它的存储目录），最后换新文档
    if (!settings) settings = await openSettingsInvoker(PORT, cdp).catch(() => null);
    if (settings) await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
    if (settings) await settings.invoke("permission_revoke", { pluginId: PID }).catch(() => undefined);
    settings?.close();
    settings = null;
    await sleep(1500); // 同上：别让撤销的异步操作撞上 reload
    await reloadAndWait(cdp).catch(() => undefined);
    await sleep(1500);
  } else {
    settings?.close();
  }
  const failed = r.summary();
  cdp?.close();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
