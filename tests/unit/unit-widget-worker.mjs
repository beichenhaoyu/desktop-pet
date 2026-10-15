// widget Worker 侧运行时的离线单测（ADR-0008 阶段二，L2 契约第三片）。
//
// 为什么能在 node 里跑：createWidgetRuntime 把「和 Worker 全局打交道」的部分留在模块底部并加了守卫，
// 工厂本身只依赖注入进来的 post / loadEntry —— 于是 region 门禁、topic ACL 的同步语义、
// 回执配对、退订幂等这些**只能靠调用顺序证明**的性质，可以不开浏览器就钉住。
// 渲染器的真 DOM 行为不在这里（归 verify:worker 第⑦组）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  WIDGET_CALL_METHODS,
  isWidgetCallAllowed,
  shouldUseWorkerWidget,
  widgetUsesWorker,
  WIDGET_WORKER_FLAG,
} from "../../src/runtime/widget-protocol.ts";
import { createWidgetRuntime } from "../../src/runtime/widget-worker.ts";

const WORKER_SRC = readFileSync(new URL("../../src/runtime/widget-worker.ts", import.meta.url), "utf8");
// 只读文本、不 import：worker-widget-host 带着 `?worker` 说明符，node 一解析就炸
const WIDGET_HOST_SRC = readFileSync(new URL("../../src/runtime/widget-host.ts", import.meta.url), "utf8");
const WORKER_WIDGET_HOST_SRC = readFileSync(
  new URL("../../src/runtime/worker-widget-host.ts", import.meta.url),
  "utf8",
);

/** 一个假 Worker：收下的 outbound 都在 sent 里，测试自己扮演宿主回包 */
function harness({ module, permissions = ["bus:publish", "bus:subscribe"], region = "badge", pluginId = "com.pet.x" } = {}) {
  const sent = [];
  const seen = [];
  const runtime = createWidgetRuntime({
    post: (msg) => sent.push(msg),
    loadEntry: async (url) => {
      seen.push(url);
      if (module instanceof Error) throw module;
      return module ?? { mount: () => undefined };
    },
  });
  // boot 走 runtime.boot（宿主实战里是从 hostMessage  fire-and-forget 进来的，那里另有一条测试覆盖）
  const boot = (over = {}) =>
    runtime.boot({ t: "boot", pluginId, entryUrl: "http://petplugin.localhost/x/widget.js", region, permissions, ...over });
  return { runtime, sent, seen, boot, last: (t) => [...sent].reverse().find((m) => m.t === t) };
}

const settle = () => new Promise((res) => setTimeout(res, 0));
/** mount 里拿到的 ctx */
function captureCtx(mod) {
  let ctx = null;
  let root = null;
  return {
    ctx: () => ctx,
    root: () => root,
    module: {
      mount: (r, c) => {
        root = r;
        ctx = c;
        return mod?.(c);
      },
    },
  };
}

describe("boot：首屏不能等下一个微任务", () => {
  it("按顺序发 ops 批次、然后才 booted", async () => {
    const cap = captureCtx((ctx) => {
      const el = ctx.dom.createElement("div");
      el.textContent = "就绪";
      ctx.dom && ctx.bus.publish("com.pet.x:tick", 1);
    });
    const h = harness({ module: cap.module });
    await h.boot();
    assert.equal(h.seen.length, 1, "入口应当被加载一次");
    // mount 体先跑（publish 是同步转出），首屏批次在 mount 返回后由 flush 落地，booted 最后
    assert.deepEqual(
      h.sent.map((m) => m.t),
      ["call", "ops", "booted"],
      `实际：${JSON.stringify(h.sent.map((m) => m.t))}`,
    );
    // 两套编号各管各的：ops 批次 seq 从 0 起（宿主靠它断言没被打乱），call 的 seq 是另一条序列
    const firstBatch = h.sent.find((m) => m.t === "ops");
    assert.equal(firstBatch.seq, 0, "首屏批次 seq 从 0 起");
    assert.notEqual(h.sent.find((m) => m.t === "call").seq, firstBatch.seq, "call 的 seq 与批次 seq 撞号了");
    assert.equal(firstBatch.ops.some((o) => o.k === "text" && o.value === "就绪"), true);
  });

  it("mount 收到的 ctx 带 pluginId 与 region", async () => {
    const cap = captureCtx(() => undefined);
    const h = harness({ module: cap.module, region: "settings" });
    await h.boot();
    assert.equal(cap.ctx().pluginId, "com.pet.x");
    assert.equal(cap.ctx().region, "settings");
    assert.equal(cap.root().nodeId, 0, "root 是宿主认领的固定 id 0");
  });

  it("入口没有 mount 导出 → boot-failed 且带 URL", async () => {
    const h = harness({ module: {} });
    await h.boot();
    const failed = h.last("boot-failed");
    assert.equal(failed.error.code, "legacy");
    assert.match(failed.error.message, /widget\.js 缺少 mount/);
    assert.equal(h.last("booted"), undefined);
  });

  it("入口加载抛错 → boot-failed", async () => {
    const h = harness({ module: new Error("404 取不到 widget.js") });
    await h.boot();
    assert.match(h.last("boot-failed").error.message, /404 取不到/);
  });

  it("mount 内部抛错 → boot-failed，不发 booted", async () => {
    const h = harness({
      module: {
        mount: () => {
          throw new Error("渲染崩了");
        },
      },
    });
    await h.boot();
    assert.match(h.last("boot-failed").error.message, /渲染崩了/);
    assert.equal(h.last("booted"), undefined);
  });
});

describe("区域边界：ctx.host 只在 settings 区存在", () => {
  it("settings 区有 agentHooks 三个方法", async () => {
    const cap = captureCtx(() => undefined);
    await harness({ module: cap.module, region: "settings" }).boot();
    assert.deepEqual(Object.keys(cap.ctx().host.agentHooks).sort(), ["install", "status", "uninstall"]);
  });

  for (const region of ["badge", "overlay"]) {
    it(`${region} 区连 host 这个键都没有（不是有但被拒）`, async () => {
      const cap = captureCtx(() => undefined);
      await harness({ module: cap.module, region }).boot();
      assert.equal("host" in cap.ctx(), false);
    });
  }

  it("settings 区调 status() 会发 call 并等宿主回包", async () => {
    // mount 里那次调用也必须被回包：boot 会 await mount 的返回值，
    // 宿主漏回一次 result 就等于让这个 widget 永远起不来（下一条把它钉住）
    const cap = captureCtx((ctx) => {
      void ctx.host.agentHooks.status();
    });
    const h = harness({ module: cap.module, region: "settings" });
    const booting = h.boot();
    await settle();
    const first = h.sent.find((m) => m.t === "call");
    assert.equal(first.method, "agentHooks.status");
    h.runtime.hostMessage({ t: "result", seq: first.seq, ok: true, value: { installed: true } });
    await booting;
    const p = cap.ctx().host.agentHooks.status();
    const call2 = h.sent.filter((m) => m.t === "call").at(-1);
    h.runtime.hostMessage({ t: "result", seq: call2.seq, ok: true, value: { installed: true } });
    assert.deepEqual(await p, { installed: true });
  });

  it("宿主漏回 result 时 boot 不会假装成功（宿主侧必须逢 call 必回）", async () => {
    const cap = captureCtx((ctx) => ctx.host.agentHooks.install());
    const h = harness({ module: cap.module, region: "settings" });
    const booting = h.boot();
    await settle();
    const stalled = await Promise.race([
      booting.then(() => "booted"),
      new Promise((res) => setTimeout(() => res("pending"), 30)),
    ]);
    assert.equal(stalled, "pending", "没回包却发出 booted —— 那会让宿主 terminate 掉一个正在等的 Worker");
    assert.equal(h.sent.some((m) => m.t === "booted"), false);
  });

  it("宿主回 ok:false → 调用方拿到带 message 的 reject", async () => {
    const cap = captureCtx(() => undefined);
    const h = harness({ module: cap.module, region: "settings" });
    await h.boot();
    const p = cap.ctx().host.agentHooks.uninstall();
    const call = h.sent.filter((m) => m.t === "call").at(-1);
    h.runtime.hostMessage({
      t: "result",
      seq: call.seq,
      ok: false,
      error: { code: "denied", message: "未授权 agent:hooks" },
    });
    await assert.rejects(p, /未授权 agent:hooks/);
  });

  it("没人在等的 seq 回包被忽略，不炸", async () => {
    const cap = captureCtx(() => undefined);
    const h = harness({ module: cap.module, region: "settings" });
    await h.boot();
    assert.doesNotThrow(() => h.runtime.hostMessage({ t: "result", seq: 4242, ok: true, value: 1 }));
  });
});

describe("topic ACL 复用宿主同一份规则（同步 throw，不是 reject）", () => {
  const withBus = async (permissions) => {
    const cap = captureCtx(() => undefined);
    const h = harness({ module: cap.module, permissions });
    await h.boot();
    return { ctx: cap.ctx(), h };
  };

  it("发自己前缀：同步返回并转出 bus.publish", async () => {
    const { ctx, h } = await withBus(["bus:publish"]);
    assert.equal(ctx.bus.publish("com.pet.x:widget", { a: 1 }), undefined);
    const call = h.sent.find((m) => m.t === "call");
    assert.deepEqual([call.method, call.args], ["bus.publish", ["com.pet.x:widget", { a: 1 }]]);
  });

  it("发别人前缀当场 throw（不是静默丢掉）", async () => {
    const { ctx } = await withBus(["bus:publish"]);
    assert.throws(() => ctx.bus.publish("com.pet.other:widget", 1), /无权发布/);
  });

  it("没声明 bus:publish 就发宿主 topic → throw", async () => {
    const { ctx } = await withBus([]);
    // 自己前缀的 topic 过得了 assertPublishable，这条走的才是「manifest 没声明 bus:publish」那一支
    assert.throws(() => ctx.bus.publish("com.pet.x:widget", 1), /声明 bus:publish/);
  });

  it("订自己前缀不需要 bus:subscribe，且退订幂等", async () => {
    const { ctx, h } = await withBus([]);
    const off = ctx.bus.subscribe("com.pet.x:widget", () => undefined);
    assert.equal(typeof off, "function");
    const sub = h.sent.find((m) => m.t === "call" && m.method === "bus.subscribe");
    assert.equal(typeof sub.sub, "number");
    off();
    assert.equal(h.sent.filter((m) => m.t === "unsub").length, 1);
    off();
    assert.equal(h.sent.filter((m) => m.t === "unsub").length, 1, "重复退订不该再发 unsub");
  });

  it("订别人的 topic 未声明 bus:subscribe → throw", async () => {
    const { ctx } = await withBus([]);
    assert.throws(() => ctx.bus.subscribe("com.pet.other:x", () => undefined), /bus:subscribe/);
  });

  it("通配订阅不得越过自己前缀", async () => {
    const { ctx } = await withBus(["bus:subscribe"]);
    assert.throws(() => ctx.bus.subscribe("*", () => undefined), /通配订阅/);
  });

  it("宿主投递按 sub 句柄派发；没人订过的句柄不炸", async () => {
    const cap = captureCtx(() => undefined);
    const h = harness({ module: cap.module, permissions: ["bus:subscribe"] });
    await h.boot();
    const got = [];
    const off = cap.ctx().bus.subscribe("com.pet.x:widget", (p) => got.push(p));
    assert.equal(off, undefined ?? off);
    const sub = h.sent.find((m) => m.method === "bus.subscribe").sub;
    h.runtime.hostMessage({ t: "bus", sub, payload: { bpm: 72 } });
    assert.deepEqual(got, [{ bpm: 72 }]);
    h.runtime.hostMessage({ t: "bus", sub: 9999, payload: 1 });
    assert.equal(got.length, 1, "未注册的句柄不该产出任何东西");
  });
});

describe("layout 与画布交接", () => {
  const booted = async (region = "badge", mod) => {
    const cap = captureCtx(mod);
    const h = harness({ module: cap.module, region });
    await h.boot();
    return { ctx: cap.ctx(), h };
  };

  it("onLayout 收到原消息，退订后不再收", async () => {
    const { ctx, h } = await booted();
    const got = [];
    const off = ctx.onLayout((l) => got.push(l.width));
    const msg = { t: "layout", width: 320, height: 80, dpr: 2, measured: {} };
    h.runtime.hostMessage(msg);
    h.runtime.hostMessage(msg);
    off();
    h.runtime.hostMessage(msg);
    assert.deepEqual(got, [320, 320]);
  });

  it("onCanvas 收到 (id, off)，退订后不再收", async () => {
    const { ctx, h } = await booted();
    const got = [];
    const off = ctx.onCanvas((id, canvas) => got.push([id, canvas]));
    h.runtime.hostMessage({ t: "handoff", id: 7, off: { fake: "offscreen" } });
    assert.deepEqual(got, [[7, { fake: "offscreen" }]]);
    off();
    h.runtime.hostMessage({ t: "handoff", id: 8, off: {} });
    assert.equal(got.length, 1);
  });

  it("没注册 onCanvas 时交接消息不炸", async () => {
    const { h } = await booted();
    assert.doesNotThrow(() => h.runtime.hostMessage({ t: "handoff", id: 1, off: {} }));
  });
});

describe("deactivate：Widget 侧自己收尾，宿主才 terminate", () => {
  it("先跑插件的 deactivate，再回执 deactivated", async () => {
    const order = [];
    const h = harness({
      module: {
        mount: () => undefined,
        deactivate: () => {
          order.push("deactivated");
        },
      },
    });
    await h.boot();
    h.runtime.hostMessage({ t: "deactivate" });
    await settle();
    assert.deepEqual(order, ["deactivated"]);
    assert.equal(h.sent.at(-1).t, "deactivated");
  });

  it("退订在停用后失效：宿主再投 bus 不会打到已注销的 handler", async () => {
    let hit = 0;
    const cap = captureCtx((ctx) => ctx.bus.subscribe("com.pet.x:widget", () => hit++));
    const h = harness({ module: cap.module, permissions: ["bus:subscribe"] });
    await h.boot();
    const sub = h.sent.find((m) => m.method === "bus.subscribe").sub;
    h.runtime.hostMessage({ t: "bus", sub, payload: 1 });
    h.runtime.hostMessage({ t: "deactivate" });
    await settle();
    h.runtime.hostMessage({ t: "bus", sub, payload: 2 });
    assert.equal(hit, 1, "停用后不该再回调插件代码");
  });

  it("boot 失败后 deactivate 也照样回执（不让宿主永远等）", async () => {
    const h = harness({ module: new Error("取不到入口") });
    await h.boot();
    h.runtime.hostMessage({ t: "deactivate" });
    await settle();
    assert.equal(h.last("deactivated").t, "deactivated");
  });

  it("deactivate 抛错也要回执", async () => {
    const h = harness({
      module: {
        mount: () => undefined,
        deactivate: () => {
          throw new Error("收尾失败");
        },
      },
    });
    await h.boot();
    h.runtime.hostMessage({ t: "deactivate" });
    await settle();
    assert.equal(h.last("deactivated").t, "deactivated");
  });
});

describe("调用面比入口的 22 表窄：不借搬迁扩权", () => {
  it("widget 只能喊这 5 个方法", () => {
    assert.deepEqual([...WIDGET_CALL_METHODS].sort(), [
      "agentHooks.install",
      "agentHooks.status",
      "agentHooks.uninstall",
      "bus.publish",
      "bus.subscribe",
    ]);
  });

  it("storage / http / pet.* 一律不在 widget 调用面上", () => {
    for (const method of ["storage.get", "http.request", "pet.say", "ble.connect", "widget.update", "notify.show"]) {
      assert.equal(isWidgetCallAllowed(method, "settings"), false, `${method} 被放行`);
    }
  });

  it("agentHooks.* 只有 settings 区算合法", () => {
    assert.equal(isWidgetCallAllowed("agentHooks.status", "settings"), true);
    assert.equal(isWidgetCallAllowed("agentHooks.status", "badge"), false);
    assert.equal(isWidgetCallAllowed("agentHooks.status", "overlay"), false);
  });

  it("非方法名与未知字符串一律拒", () => {
    for (const bad of [undefined, "", "eval", "constructor", 42]) {
      assert.equal(isWidgetCallAllowed(bad, "settings"), false);
    }
  });
});

describe("opt-in 名单（第二阶段默认仍留宿主 realm）", () => {
  it("空值与未点名都是 false", () => {
    for (const raw of ["", null, undefined, "   ", "com.pet.other"]) {
      assert.equal(shouldUseWorkerWidget("com.pet.x", raw), false, `${JSON.stringify(raw)} 被判成进 Worker`);
    }
  });

  it("点名才进，含空格也认", () => {
    assert.equal(shouldUseWorkerWidget("com.pet.x", "com.pet.other, com.pet.x "), true);
    assert.equal(shouldUseWorkerWidget("com.pet.y", "com.pet.x"), false);
  });

  it("flag 名字不许改：它进了约定与回归脚本", () => {
    assert.equal(WIDGET_WORKER_FLAG, "host:widget-worker-plugin-host");
  });
});

describe("迁移台账：命中台账即对真实用户生效，不靠开发态点名", () => {
  it("台账命中 ⇒ 进 Worker，哪怕没点名", () => {
    assert.equal(widgetUsesWorker("com.pet.x", "", ["com.pet.x"]), true);
    assert.equal(widgetUsesWorker("com.pet.x", null, ["com.pet.x"]), true);
  });

  it("点名仍独立生效（并集，台账不覆盖点名）", () => {
    assert.equal(widgetUsesWorker("com.pet.x", "com.pet.x", []), true);
  });

  it("两条都不沾 ⇒ 留宿主 realm（默认没翻）", () => {
    for (const raw of ["", null, undefined, "com.pet.other"]) {
      assert.equal(widgetUsesWorker("com.pet.x", raw, ["com.pet.y"]), false);
    }
  });

  it("两个接缝调用点都走台账，不许绕过它直接用点名解析器", () => {
    // 绕过一处就等于那条路认不出「已迁移」，插件在宿主 realm 里白屏
    for (const src of [WIDGET_HOST_SRC, WORKER_WIDGET_HOST_SRC]) {
      assert.equal(src.includes("widgetUsesWorker("), true, "调用点没走 widgetUsesWorker");
      assert.equal(/shouldUseWorkerWidget\s*\(/.test(src), false, "调用点直接用了点名解析器");
    }
  });
});

describe("隔离：Worker 侧不许把 IPC 入口带进 bundle", () => {
  it("widget-worker.ts 不 import @tauri-apps / host-error", () => {
    assert.equal(/from\s+"@tauri-apps|import\(\s*"@tauri-apps/.test(WORKER_SRC), false);
    assert.equal(/from\s+"[^"]*host-error/.test(WORKER_SRC), false);
  });

  it("widget-worker.ts 只 import 这三个纯模块", () => {
    const specs = [...WORKER_SRC.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(specs.sort(), ["./topic-acl", "./widget-node", "./widget-protocol"]);
  });

  it("自举有守卫，所以 node 里 import 它不会炸", () => {
    assert.match(WORKER_SRC, /typeof self !== "undefined"/);
  });
});
