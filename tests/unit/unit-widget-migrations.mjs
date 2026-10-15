// 迁移冒烟（离线）：把插件的 widget.js 真的在 Worker 侧运行时里跑一遍。
//
// 为什么要它：四张迁移卡如果都靠 CDP 运行时套件取证，就得抢同一个调试端口与单实例锁，
// 等于串行。这个冒烟不开浏览器、不占端口、秒级，能抓住迁移中最常见的一类破 ——
// 残留 `document.*`（Worker 里必然 ReferenceError）、用了表外的标签/属性名（宿主那条门禁就是
// `isWidgetOp`，这里照它逐条过一遍）。**它抓不到视觉与交互**，那仍以各插件的运行时套件为准。
//
// 名单来源与生产同一处：`WIDGET_WORKER_MIGRATED`（PM 验收迁移卡时追加）。
// 插件作者想在台账之外先试自己那一个：`PET_WIDGET_SMOKE=com.pet.xxx`（逗号分隔）。
//
// 反向那半同样是指望：台账外的真实插件**必须**跑不起来。哪天冒烟对谁都绿，它就是空转了。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { WIDGET_WORKER_MIGRATED, isWidgetOp } from "../../src/runtime/widget-protocol.ts";
import { createWidgetRuntime } from "../../src/runtime/widget-worker.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGIONS = ["badge", "overlay", "settings"];
/** 仓库自带的四个示例插件（迁移对象就是它们） */
const REAL = ["com.pet.todo", "com.pet.agent-bridge", "com.pet.hr-ble", "com.pet.astock"];
/** 常驻基线：夹具那份是双 realm 写法，今天就该过 —— 它证明这套冒烟本身不是空转 */
const FIXTURE_DIR = join("tests", "fixtures", "l1-probe");

const extraIds = () =>
  (process.env.PET_WIDGET_SMOKE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const targets = () => [...new Set([...WIDGET_WORKER_MIGRATED, ...extraIds()])];

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(REPO, dir, "manifest.json"), "utf8"));
}

/** 替身宿主的回包：形状给最空的。真实套件里才有真数据，所以形状敏感的逻辑不靠本文件判。 */
const replyFor = (method) => (String(method).startsWith("agentHooks.") ? {} : null);

/** 事件快照：与宿主 renderer 那份同形（keydown 给按键名，change/input 给 value+checked） */
const eventValueFor = (event) =>
  event === "keydown" ? { key: "Enter" } : { value: "1", checked: true };

/**
 * 数据驱动的那段渲染，不喂 payload 根本跑不到 —— 列表类分支只在收到总线消息时才执行。
 * 这条口径是被一次**存活的变异**逼出来的：把勾选取的 `on("change")` 改成表外事件名 `submit`，
 * 冒烟照绿，因为那条 `taskRow` 从没被执行过。
 *
 * 每个插件登记一份「有内容」的假 payload（空数组不算喂到），由 PM 在验收每张迁移卡时对着
 * 该插件自己发的那条总线补。喂进去之后新增的 op 一样逐条过门禁。
 */
const BUS_POKE = {
  "com.pet.todo": {
    openCount: 1,
    doneCount: 0,
    tasks: [{ id: "a", text: "写周报", done: false, line: "(A) 写周报", projects: ["工作"] }],
  },
  // 一份 payload 喂三个区：badge / overlay 读 state-label-steps-title-detail，settings 读两个开关
  "com.pet.agent-bridge": {
    state: "running",
    label: "编辑文件",
    steps: 3,
    title: "补迁移冒烟",
    detail: "tests/unit/unit-widget-migrations.mjs",
    toolName: "Edit",
    showTitle: true,
    showDetail: true,
  },
};

/** 画布替身：`getContext("2d")` 回来的一切调用都是空操作，属性写全部吞掉。
 *  它证明的是**那段绘图代码在 Worker 里跑得完**，不是图画得对 —— 后者归 verify:astock（真数像素）。 */
function stubCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "measureText") return () => ({ width: 8 });
        if (key === "createLinearGradient" || key === "createRadialGradient")
          return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: () => true,
    },
  );
  return { width: 0, height: 0, getContext: () => ctx };
}

/** 在 Worker 侧运行时里跑一遍：返回 ops、越界 op、调用面外的方法名、以及失败原因 */
async function smoke(dir, region, module = null) {
  const entry = module ? "about:blank#inline" : pathToFileURL(join(REPO, dir, "widget.js")).href;
  const manifest = module ? { id: "zz.smoke", permissions: [] } : manifestOf(dir);
  const ops = [];
  const badOps = [];
  const calls = [];
  const listeners = [];
  const canvasIds = [];
  const subs = [];
  let bootError = null;
  let booted = false;

  const runtime = createWidgetRuntime({
    post: (msg) => {
      if (msg.t === "ops") {
        for (const op of msg.ops) {
          ops.push(op);
          if (!isWidgetOp(op)) badOps.push(op);
          if (op?.k === "listen") listeners.push(op);
          if (op?.k === "create" && op?.tag === "canvas") canvasIds.push(op.id);
        }
        return;
      }
      if (msg.t === "call") {
        calls.push(msg.method);
        if (msg.method === "bus.subscribe" && typeof msg.sub === "number") subs.push(msg.sub);
        // 逢 call 必回：真宿主怎么回，这里就怎么回，否则 mount 里的调用会把冒烟吊死
        queueMicrotask(() =>
          runtime.hostMessage({ t: "result", seq: msg.seq, ok: true, value: replyFor(msg.method) }),
        );
        return;
      }
      if (msg.t === "booted") booted = true;
      if (msg.t === "boot-failed") bootError = msg.error?.message ?? "未知失败";
    },
    loadEntry: async () => module ?? import(entry),
  });

  await runtime.boot({
    t: "boot",
    pluginId: manifest.id,
    entryUrl: entry,
    region,
    permissions: manifest.permissions ?? [],
  });

  /** 让批次落地后再收一遍新增的 op */
  const settle = async () => {
    await new Promise((res) => setTimeout(res, 20));
  };
  const fired = new Set();
  const dispatchListeners = async () => {
    for (const l of [...listeners]) {
      const key = `${l.id}:${l.event}`;
      if (fired.has(key)) continue;
      fired.add(key);
      runtime.hostMessage({ t: "event", id: l.id, event: l.event, value: eventValueFor(l.event) });
    }
    await settle();
  };

  const opsAfterMount = ops.length;

  // 1) 先把数据喂进去。列表类节点是数据驱动的：不喂的时候它们压根不存在，
  //    里面的监听也无从触发 —— 顺序反了会得到「触发了 1 个监听却没有新增 op」这种假红。
  //    见 BUS_POKE 上方那段（这条口径是被一次存活的变异逼出来的）。
  const poke = BUS_POKE[manifest.id] ?? null;
  const opsBeforePoke = ops.length;
  for (const s of subs) {
    runtime.hostMessage({ t: "bus", sub: s, payload: poke ?? {} });
  }
  await settle();
  const opsAfterPoke = ops.length;

  // 2) 事件回调里发生的渲染：每个 listen op 触发一次，新增的 op 照样过门禁
  const listenerCountBeforeEvents = listeners.length;
  const callsBeforeEvents = calls.length;
  const opsBeforeEvents = ops.length;
  await dispatchListeners();
  const opsAfterEvents = ops.length;
  const callsAfterEvents = calls.length;

  // 3) layout 与 handoff：图表类的绘制入口在这两个回调里
  runtime.hostMessage({
    t: "layout",
    width: 320,
    height: 120,
    dpr: 1,
    measured: Object.fromEntries(canvasIds.map((id) => [String(id), { w: 100, h: 60 }])),
  });
  await settle();
  for (const id of canvasIds) {
    runtime.hostMessage({ t: "handoff", id, off: stubCanvas() });
  }
  await settle();
  // 上面两步可能又登记了新监听，补一轮
  await dispatchListeners();

  // 收尾让插件自己清定时器：留着的测试进程不退出，看起来像挂死而不是断言失败
  runtime.hostMessage({ t: "deactivate" });
  await settle();
  return {
    ops,
    badOps,
    calls,
    bootError,
    booted,
    listenCount: listeners.length,
    listenerCountBeforeEvents,
    canvasCount: canvasIds.length,
    subCount: subs.length,
    hasPoke: poke !== null,
    opsAfterMount,
    opsBeforePoke,
    opsAfterPoke,
    opsBeforeEvents,
    opsAfterEvents,
    callsBeforeEvents,
    callsAfterEvents,
  };
}

/** 三条套件共用的断言：跑得起来、有渲染、事件/layout/画布回调都过门禁 */
function assertClean(r, label) {
  assert.equal(r.bootError, null, `${label} 挂载失败：${r.bootError}`);
  assert.equal(r.booted, true, `${label} 没有 booted 回执`);
  assert.ok(r.ops.length > 0, `${label} 一条 op 都没发，等于没渲染`);
  assert.deepEqual(r.badOps, [], `${label} 有 ${r.badOps.length} 条 op 过不了宿主门禁`);
}

/**
 * 监听触发过之后要有动静。动静**可以是新 op，也可以是一次总线/宿主调用** ——
 * 勾选框那种处理函数就是纯动作（publish 一条指令、不重画自己），只盯 op 会把正确实现判成红。
 * 没登记任何监听时不硬要求（badge 区就没有）。
 */
function assertEventsRendered(r, label) {
  if (r.listenerCountBeforeEvents > 0) {
    const moved = r.opsAfterEvents > r.opsBeforeEvents || r.callsAfterEvents > r.callsBeforeEvents;
    assert.ok(
      moved,
      `${label} 触发了 ${r.listenerCountBeforeEvents} 个监听，既没新增 op 也没有任何调用（实得 ops ${
        r.opsAfterEvents - r.opsBeforeEvents
      }、calls ${r.callsAfterEvents - r.callsBeforeEvents}）`,
    );
  }
}

/** 台账内 / 点名里的插件必须登记 BUS_POKE：没登记就意味着列表类分支从没被执行过，
 *  「冒烟绿」只覆盖了 mount 那一半 —— A10 那次存活的变异就是这么漏过去的。 */
function assertPokeRendered(r, label) {
  assert.ok(r.subCount > 0, `${label} 一条订阅都没有，喂不进数据`);
  assert.equal(r.hasPoke, true, `${label} 没在 BUS_POKE 里登记假 payload，数据驱动那段渲染跑不到`);
  assert.ok(r.opsAfterPoke > r.opsBeforePoke, `${label} 喂了 payload 却没多发一条 op`);
}

describe("常驻基线：夹具那份双 realm 写法必须跑得起来", () => {
  for (const region of REGIONS) {
    it(`夹具 widget 在 ${region} 区零越界`, async () => {
      const r = await smoke(FIXTURE_DIR, region);
      assertClean(r, `夹具 ${region}`);
      assertEventsRendered(r, `夹具 ${region}`);
    });
  }
});

describe("台账内的插件必须能在 Worker realm 里跑起来", () => {
  const ids = targets();
  if (ids.length === 0) {
    it("（当前没有已迁移插件，也没有 PET_WIDGET_SMOKE 点名）", () => {
      assert.equal(ids.length, 0);
    });
  }
  for (const id of ids) {
    for (const region of REGIONS) {
      it(`${id} 在 ${region} 区跑得起来且不越界`, async () => {
        const r = await smoke(join("plugins", id), region);
        assertClean(r, `${id} ${region}`);
        assertEventsRendered(r, `${id} ${region}`);
        assertPokeRendered(r, `${id} ${region}`);
      });
    }
  }
});

describe("台账外的真实插件必须跑不起来（冒烟不是空转）", () => {
  for (const id of REAL.filter((x) => !targets().includes(x))) {
    it(`${id} 还没迁，Worker 里就该当场失败`, async () => {
      const r = await smoke(join("plugins", id), "badge");
      assert.notEqual(r.bootError, null, "未迁移的插件居然在 Worker realm 里跑起来了");
      assert.match(String(r.bootError), /document|window|localStorage|not defined/);
    });
  }
});

/** 事件分发那半是这轮新加的，四个真实插件全都跑不到那里（它们 mount 就挂了），
 *  所以用两个合成 widget 自己证明自己会红。 */
describe("冒烟自己：只在事件回调里渲染的那段代码也在覆盖内", () => {
  const goodClick = {
    mount(root, ctx) {
      const box = ctx.dom.createElement("div");
      box.on("click", () => {
        const span = ctx.dom.createElement("span");
        span.textContent = "点出来的";
        box.append(span);
      });
      root.append(box);
    },
  };
  const badClick = {
    mount(root, ctx) {
      const box = ctx.dom.createElement("div");
      // href 不在 attr 表里（资源加载能力），而它只在回调里才发得出来
      box.on("click", () => box.setAttribute("href", "https://example.com"));
      root.append(box);
    },
  };

  it("合法回调：触发监听后确实新增 op，且一条不越界", async () => {
    const r = await smoke(null, "settings", goodClick);
    assert.equal(r.listenCount, 1);
    assert.equal(r.opsAfterEvents > r.opsAfterMount, true, "事件回调里没渲染出任何东西");
    assert.deepEqual(r.badOps, []);
  });

  it("越界回调：冒烟抓得到（否则整张卡都在自欺）", async () => {
    const r = await smoke(null, "settings", badClick);
    assert.equal(r.badOps.length, 1, `本该挑出 1 条越界 op，实际 ${r.badOps.length} 条`);
  });
});
