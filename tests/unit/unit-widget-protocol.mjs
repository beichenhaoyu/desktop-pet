// widget 渲染契约与 Worker 侧虚拟节点的离线单测（ADR-0008 / L2 阶段二）。
//
// 为什么值这些形状而不是值「渲染出来好看」：宿主侧 apply 只能在这一层给出的白名单上做判断，
// 词表一泄，隔离就变成一句注释。本文件里最要紧的是那三条「不许有」的断言：
// 没有 html op、没有 class op kind、两个模块都不许带进 IPC 入口。
//
// 零 GUI、零联网、不开 DOM —— 宿主侧 apply（要真 ShadowRoot）不在这里验，归运行时套件。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  WIDGET_ATTRS,
  WIDGET_EVENTS,
  WIDGET_HTML_TAGS,
  WIDGET_MAX_OPS_PER_MESSAGE,
  WIDGET_OP_KINDS,
  WIDGET_PROPS,
  WIDGET_SVG_TAGS,
  isWidgetAttr,
  isWidgetEvent,
  isWidgetOp,
  isWidgetProp,
  isWidgetStyleProp,
  isWidgetTag,
  isWidgetToHost,
} from "../../src/runtime/widget-protocol.ts";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";

const PROTO_SRC = readFileSync(new URL("../../src/runtime/widget-protocol.ts", import.meta.url), "utf8");
const NODE_SRC = readFileSync(new URL("../../src/runtime/widget-node.ts", import.meta.url), "utf8");

/** 只认真实 import 形态：注释里写 @tauri-apps 不算命中（这条口径在 unit-worker-host 里被证过一次）。 */
const importsTauri = (src) => /from\s+"@tauri-apps|import\(\s*"@tauri-apps/.test(src);
const importsHostError = (src) => /from\s+"[^"]*host-error|import\(\s*"[^"]*host-error/.test(src);

/** 收集 session 发出的每一条 ops 消息 */
const collect = () => {
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  return { session, sent };
};

/** 微任务里批次才会落地，测试用这个显式等一轮 */
const settle = () => new Promise((res) => queueMicrotask(res));

describe("词表是闭集：多一个名字等于扩大攻击面", () => {
  it("op kind 恰好是这 12 个，顺序无关", () => {
    assert.deepEqual([...WIDGET_OP_KINDS].sort(), [
      "adopt",
      "append",
      "attr",
      "create",
      "dataset",
      "listen",
      "prop",
      "remove",
      "replace",
      "style",
      "text",
      "unlisten",
    ]);
  });

  // ADR-0008 决策 6 的全部牙齿在这一条：协议里没有标记注入的入口，且不许有人加回来
  it("没有 html / innerHTML 这一类 op", () => {
    for (const forbidden of ["html", "innerHTML", "insertAdjacentHTML", "markup", "outerHTML"]) {
      assert.equal(WIDGET_OP_KINDS.includes(forbidden), false, `词表里出现了 ${forbidden}`);
    }
    assert.equal(/\bk:\s*"(html|innerHTML)"/.test(PROTO_SRC), false);
  });

  it("classList 不配新的 op kind：类名整串走 attr class", () => {
    assert.equal(WIDGET_OP_KINDS.includes("class"), false);
    assert.ok(WIDGET_ATTRS.includes("class"));
  });

  it("标签白名单不开导航与资源加载能力", () => {
    for (const forbidden of ["script", "iframe", "object", "embed", "a", "form", "link", "meta", "base"]) {
      assert.equal(isWidgetTag(forbidden), false, `${forbidden} 被当成了合法标签`);
    }
    assert.ok(WIDGET_HTML_TAGS.includes("style"), "四个插件都从 JS 往自己的 shadow root 注入 CSS");
  });

  it("属性白名单不含 src / href / style 逐条属性", () => {
    for (const forbidden of ["src", "href", "style", "xlink:href", "srcset"]) {
      assert.equal(isWidgetAttr(forbidden), false, `${forbidden} 被当成了合法属性`);
    }
  });

  // 撤掉一个名字也要留证据，否则下次有人当它是漏写又加回来
  it("两张标签表不相交：否则 create 用 svg 标记选表这件事形同虚设", () => {
    const overlap = WIDGET_HTML_TAGS.filter((t) => WIDGET_SVG_TAGS.includes(t));
    assert.deepEqual(overlap, []);
    // 命名空间混用在形状层就拒：div 不许带 svg，path 不许不带 svg
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "div", svg: true }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "path" }), false);
    assert.ok(isWidgetOp({ k: "create", id: 1, tag: "stop", svg: true }));
  });

  it("title 已从两张表撤掉（全库实测 0 处使用）", () => {
    assert.equal(WIDGET_PROPS.includes("title"), false);
    assert.equal(isWidgetProp("title"), false);
    assert.equal(isWidgetAttr("title"), false);
  });

  it("事件名按实测来：resize 不在这里（它走 layout 推送），submit 没被用到就不开", () => {
    assert.deepEqual([...WIDGET_EVENTS].sort(), ["change", "click", "input", "keydown"]);
    assert.equal(isWidgetEvent("resize"), false);
    assert.equal(isWidgetEvent("submit"), false);
    assert.equal(isWidgetEvent("wheel"), false);
  });

  it("prop 与 attr 是两张表：value/checked 写 attribute 不生效", () => {
    assert.ok(isWidgetProp("value") && isWidgetProp("checked"));
    assert.equal(isWidgetAttr("value"), false);
    assert.equal(isWidgetAttr("checked"), false);
  });

  it("样式属性只认驼峰闭集，kebab 与未知名字一律拒", () => {
    assert.ok(isWidgetStyleProp("flexDirection"));
    assert.equal(isWidgetStyleProp("flex-direction"), false);
    assert.equal(isWidgetStyleProp("--evil-var"), false);
  });
});

describe("op 形状：kind 在闭集里 + 字段齐 + 名字在白名单里", () => {
  it("合法形状通过", () => {
    assert.ok(isWidgetOp({ k: "create", id: 3, tag: "div" }));
    assert.ok(isWidgetOp({ k: "create", id: 4, tag: "path", svg: true }));
    assert.ok(isWidgetOp({ k: "append", parent: 1, child: 3 }));
    assert.ok(isWidgetOp({ k: "replace", parent: 1, children: [2, 3] }));
    assert.ok(isWidgetOp({ k: "text", id: 3, value: "72 bpm" }));
    assert.ok(isWidgetOp({ k: "prop", id: 3, name: "checked", value: true }));
    assert.ok(isWidgetOp({ k: "attr", id: 3, name: "stop-color", value: "#ff7a8c" }));
    assert.ok(isWidgetOp({ k: "style", id: 3, props: { width: "100%", opacity: 0.5 } }));
    assert.ok(isWidgetOp({ k: "dataset", id: 3, key: "sym", value: "sh600000" }));
    assert.ok(isWidgetOp({ k: "listen", id: 3, event: "change" }));
    assert.ok(isWidgetOp({ k: "listen", id: 3, event: "keydown", preventDefault: true }));
    assert.ok(isWidgetOp({ k: "unlisten", id: 3, event: "click" }));
    assert.ok(isWidgetOp({ k: "adopt", id: 0, root: true }));
    assert.ok(isWidgetOp({ k: "remove", id: 3 }));
  });

  it("非法形状逐个被拒（每种坏一个样本，不许靠「反正都不合法」蒙）", () => {
    assert.equal(isWidgetOp(null), false);
    assert.equal(isWidgetOp("create"), false);
    assert.equal(isWidgetOp({ k: "html", id: 1, value: "<script>" }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1.5, tag: "div" }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1 }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "script" }), false);
    // 命名空间混用：svg:true 只准 SVG 标签，没标只准 HTML 标签
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "div", svg: true }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "path" }), false);
    assert.equal(isWidgetOp({ k: "append", parent: 1 }), false);
    assert.equal(isWidgetOp({ k: "replace", parent: 1, children: [2, "x"] }), false);
    assert.equal(isWidgetOp({ k: "text", id: 1 }), false);
    assert.equal(isWidgetOp({ k: "prop", id: 1, name: "onclick", value: "alert(1)" }), false);
    assert.equal(isWidgetOp({ k: "attr", id: 1, name: "src", value: "http://x" }), false);
    assert.equal(isWidgetOp({ k: "style", id: 1, props: { color: "red", bad: 1 } }), false);
    assert.equal(isWidgetOp({ k: "style", id: 1, props: { width: Number.NaN } }), false);
    assert.equal(isWidgetOp({ k: "dataset", id: 1, key: 2, value: "x" }), false);
    assert.equal(isWidgetOp({ k: "listen", id: 1, event: "mousemove" }), false);
    assert.equal(isWidgetOp({ k: "listen", id: 1, event: "click", preventDefault: "yes" }), false);
    assert.equal(isWidgetOp({ k: "adopt", id: 0 }), false);
  });

  it("outbound 消息：call 的方法名必须在 22 能力表里，ops 逐条验形状", () => {
    assert.ok(isWidgetToHost({ t: "ops", seq: 0, ops: [{ k: "remove", id: 2 }] }));
    assert.equal(isWidgetToHost({ t: "ops", seq: 0, ops: [{ k: "html", id: 2 }] }), false);
    assert.equal(isWidgetToHost({ t: "ops", seq: "0", ops: [] }), false);
    assert.ok(isWidgetToHost({ t: "call", seq: 1, method: "storage.get", args: ["k"] }));
    assert.equal(isWidgetToHost({ t: "call", seq: 1, method: "pet.teleport", args: [] }), false);
    assert.ok(isWidgetToHost({ t: "booted" }));
    assert.ok(isWidgetToHost({ t: "deactivated" }));
    assert.ok(isWidgetToHost({ t: "boot-failed", error: { code: "parse", message: "m" } }));
    assert.equal(isWidgetToHost({ t: "boot-failed", error: { code: "parse" } }), false);
    assert.equal(isWidgetToHost({ t: "eval", code: "1" }), false);
    assert.equal(isWidgetToHost(undefined), false);
  });

  it("单条消息的 op 上限是个真数字（批次实现依赖它）", () => {
    assert.equal(WIDGET_MAX_OPS_PER_MESSAGE, 512);
  });
});

describe("虚拟节点：每次调用只改本地状态并攒一条 op", () => {
  it("root 是 0，建出来的节点从 1 开始单调递增", () => {
    const { session } = collect();
    assert.equal(session.root.nodeId, 0);
    const a = session.create("div");
    const b = session.create("span");
    assert.deepEqual([a.nodeId, b.nodeId], [1, 2]);
  });

  it("三次写合并成一条消息，seq 从 0 递增", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.textContent = "你好";
    el.className = "a b";
    await settle();
    assert.equal(sent.length, 1, "微任务内该只发一条消息");
    assert.equal(sent[0].seq, 0);
    assert.deepEqual(sent[0].ops.map((o) => o.k), ["create", "text", "attr"]);
  });

  it("超过上限就切成连续多条，seq 递增且总条数不丢", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    for (let i = 0; i < WIDGET_MAX_OPS_PER_MESSAGE + 7; i++) el.textContent = String(i);
    await settle();
    const total = sent.reduce((n, m) => n + m.ops.length, 0);
    assert.equal(total, WIDGET_MAX_OPS_PER_MESSAGE + 8);
    assert.ok(sent.length >= 2, "应当切成多条消息");
    assert.deepEqual(sent.map((m) => m.seq), sent.map((_m, i) => i));
    assert.ok(sent.slice(0, -1).every((m) => m.ops.length === WIDGET_MAX_OPS_PER_MESSAGE));
  });

  it("classList.toggle 在 Worker 侧留状态，整串当 attr class 下发", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.classList.add("on");
    assert.equal(el.classList.toggle("on"), false, "已有则 toggle 应当返回 false");
    assert.equal(el.classList.contains("on"), false);
    await settle();
    const classes = sent.flatMap((m) => m.ops).filter((o) => o.k === "attr" && o.name === "class");
    assert.deepEqual(classes.map((o) => o.value), ["on", ""]);
    assert.equal(sent.flatMap((m) => m.ops).some((o) => o.k === "class"), false, "不许出现 class op kind");
  });

  it("样式逐属性赋值各发一条 style op，名字原样", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.style.width = "100%";
    el.style.opacity = 0.5;
    await settle();
    const styles = sent.flatMap((m) => m.ops).filter((o) => o.k === "style");
    assert.deepEqual(styles, [
      { k: "style", id: el.nodeId, props: { width: "100%" } },
      { k: "style", id: el.nodeId, props: { opacity: 0.5 } },
    ]);
  });

  it("dataset 写入发值、删除发 null（宿主按 removeAttribute 解释）", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.dataset.sym = "sh600000";
    delete el.dataset.sym;
    await settle();
    assert.deepEqual(
      sent.flatMap((m) => m.ops).filter((o) => o.k === "dataset"),
      [
        { k: "dataset", id: el.nodeId, key: "sym", value: "sh600000" },
        { k: "dataset", id: el.nodeId, key: "sym", value: null },
      ],
    );
  });

  it("value / checked 是 property 写：既发 prop op，也能读回来", async () => {
    const { session, sent } = collect();
    const el = session.create("input");
    el.value = "600519";
    el.checked = true;
    await settle();
    const props = sent.flatMap((m) => m.ops).filter((o) => o.k === "prop");
    assert.deepEqual(props, [
      { k: "prop", id: el.nodeId, name: "value", value: "600519" },
      { k: "prop", id: el.nodeId, name: "checked", value: true },
    ]);
    assert.equal(el.value, "600519");
    assert.equal(el.checked, true);
  });

  it("el.id = 写的是 DOM id，不许覆盖宿主句柄 nodeId", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    const before = el.nodeId;
    el.id = "hr-panel";
    await settle();
    assert.equal(el.nodeId, before, "句柄被插件赋值覆盖了");
    assert.equal(el.id, "hr-panel");
    const op = sent.flatMap((m) => m.ops).find((o) => o.k === "prop" && o.name === "id");
    assert.deepEqual(op, { k: "prop", id: before, name: "id", value: "hr-panel" });
  });

  it("setAttribute 写 class 走 className 那条唯一真相，不另发一套状态", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.classList.add("x");
    el.setAttribute("class", "y z");
    await settle();
    assert.equal(el.className, "y z");
    const attrs = sent.flatMap((m) => m.ops).filter((o) => o.k === "attr" && o.name === "class");
    assert.deepEqual(attrs.map((o) => o.value), ["x", "y z"]);
  });

  it("appendChild / append / replaceChildren / remove 的字段形状", async () => {
    const { session, sent } = collect();
    const parent = session.create("div");
    const a = session.create("span");
    const b = parent.appendChild(session.create("i"));
    parent.append(a, b);
    parent.replaceChildren(a);
    a.remove();
    await settle();
    const ops = sent.flatMap((m) => m.ops);
    assert.ok(ops.some((o) => o.k === "append" && o.parent === parent.nodeId && o.child === a.nodeId));
    assert.ok(ops.some((o) => o.k === "replace" && o.parent === parent.nodeId && o.children.length === 1));
    assert.ok(ops.some((o) => o.k === "remove" && o.id === a.nodeId));
    assert.equal(b.tag, "i");
  });

  it("on 发 listen、off 发 unlisten；preventDefault 只在明确要求时出现", async () => {
    const { session, sent } = collect();
    const el = session.create("input");
    el.on("keydown", () => undefined);
    el.on("keydown", () => undefined, { preventDefault: true });
    el.off("keydown");
    await settle();
    const listens = sent.flatMap((m) => m.ops).filter((o) => o.k === "listen");
    assert.deepEqual(listens, [
      { k: "listen", id: el.nodeId, event: "keydown" },
      { k: "listen", id: el.nodeId, event: "keydown", preventDefault: true },
    ]);
    assert.ok(sent.flatMap((m) => m.ops).some((o) => o.k === "unlisten" && o.event === "keydown"));
  });

  it("宿主回推事件：先把 value 写回节点，且不回声发 op", () => {
    const { session, sent } = collect();
    const el = session.create("select");
    let seen = null;
    el.on("change", (e) => {
      seen = e;
    });
    session.handleEvent(el.nodeId, "change", { value: "sh600519" });
    // 不显式 flush 的话，op 还积在 pending 里，下面那句「没有回声」就是恒真 —— 变异测试把这一条抓出来了
    session.flush();
    assert.equal(el.value, "sh600519", "下拉框回读拿到的应当是用户刚选的值");
    assert.equal(seen.target, el);
    const echoed = sent.flatMap((m) => m.ops).filter((o) => o.k === "prop" && o.name === "value");
    assert.equal(echoed.length, 0, "宿主已经知道这个值，回声会写成两个真相");
  });

  it("keydown 的按键名进 handler，其余字段不乱塞", () => {
    const { session } = collect();
    const el = session.create("input");
    const keys = [];
    el.on("keydown", (e) => keys.push(e.key));
    session.handleEvent(el.nodeId, "keydown", { key: "Enter" });
    session.handleEvent(el.nodeId, "keydown", {});
    assert.deepEqual(keys, ["Enter", undefined]);
  });

  it("没绑过 handler 的节点收到事件不炸（宿主可能推给已 unmount 的 id）", () => {
    const { session } = collect();
    const el = session.create("div");
    assert.doesNotThrow(() => session.handleEvent(el.nodeId, "click", {}));
    assert.doesNotThrow(() => session.handleEvent(9999, "click", { value: "x" }));
  });

  it("discard 之后既没有 handler 也没有待发 ops", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.on("click", () => assert.fail("停用后不该再回调"));
    el.textContent = "还没发出去";
    session.discard();
    await settle();
    assert.equal(sent.length, 0);
    assert.doesNotThrow(() => session.handleEvent(el.nodeId, "click", {}));
  });

  it("createSvg 只认 SVG 那一个命名空间串", () => {
    const { session } = collect();
    assert.equal(session.createSvg("http://www.w3.org/2000/svg", "path").tag, "path");
    assert.throws(() => session.createSvg("http://www.w3.org/1999/xhtml", "div"), /不支持的命名空间/);
  });

  it("dom 面是闭集：只给 createElement / createElementNS", () => {
    const { session } = collect();
    const dom = createDomFacade(session);
    assert.deepEqual(Object.keys(dom).sort(), ["createElement", "createElementNS"]);
    assert.equal(dom.querySelector, undefined);
    assert.equal(dom.createTextNode, undefined);
  });

  it("flush 可以被宿主显式调用，首屏不等下一个微任务", () => {
    const { session, sent } = collect();
    session.create("div");
    session.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ops.length, 1);
  });
});

describe("隔离：这两个模块不许把 IPC 入口带进 Worker", () => {
  // 一旦被 Worker 侧拉到，插件 Worker 的 bundle 里就躺着真正的 IPC 入口，隔离当场作废
  it("widget-protocol.ts 不带 @tauri-apps 也不带 host-error", () => {
    assert.equal(importsTauri(PROTO_SRC), false);
    assert.equal(importsHostError(PROTO_SRC), false);
  });

  it("widget-node.ts 不带 @tauri-apps 也不带 host-error", () => {
    assert.equal(importsTauri(NODE_SRC), false);
    assert.equal(importsHostError(NODE_SRC), false);
  });

  it("协议文件只 import 同层的 worker 协议（拿 22 表做校验），不引宿主侧实现", () => {
    const specs = [...PROTO_SRC.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(specs, ["./plugin-worker-protocol"]);
  });

  it("节点文件只 import 协议，不 import 任何运行时模块", () => {
    const specs = [...NODE_SRC.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(specs, ["./widget-protocol"]);
  });
});
