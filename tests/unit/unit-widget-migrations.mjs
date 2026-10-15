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

  // 只跑 mount() 一条路径不够：设置页大量渲染是**事件回调里**发生的，那段代码里的
  // 表外名字只有真把事件打回去才会被执行。每个 listen op 触发一次，新增的 op 照样过门禁。
  const opsAfterMount = ops.length;
  for (const l of listeners) {
    runtime.hostMessage({ t: "event", id: l.id, event: l.event, value: eventValueFor(l.event) });
  }
  await settle();
  const opsAfterEvents = ops.length;

  // layout 与 handoff 同理：图表类的绘制入口在这两个回调里
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
    canvasCount: canvasIds.length,
    opsAfterMount,
    opsAfterEvents,
  };
}

/** 三条套件共用的断言：跑得起来、有渲染、事件/layout/画布回调都过门禁 */
function assertClean(r, label) {
  assert.equal(r.bootError, null, `${label} 挂载失败：${r.bootError}`);
  assert.equal(r.booted, true, `${label} 没有 booted 回执`);
  assert.ok(r.ops.length > 0, `${label} 一条 op 都没发，等于没渲染`);
  assert.deepEqual(r.badOps, [], `${label} 有 ${r.badOps.length} 条 op 过不了宿主门禁`);
}

/** 事件回调里有没有真的渲染出东西：没登记任何监听时不硬要求（badge 区就没有） */
function assertEventsRendered(r, label) {
  if (r.listenCount > 0) {
    assert.ok(r.opsAfterEvents > r.opsAfterMount, `${label} 触发了 ${r.listenCount} 个监听却没有新增 op`);
  }
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
