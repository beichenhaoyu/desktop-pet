// L2 阶段二：宿主侧的 ops apply（ADR-0008）。
//
// widget 的代码在 Worker realm 里，它发来的只是一串 `WidgetOp`。这个文件是那条通道的宿主端：
// 按 op 改自己那棵 shadow tree，并把 DOM 事件**净化成标量快照**回推。
//
// 三条边界写在这里，不是写在注释里靠自觉：
// 1. **只承认自己按 op 创建过的 nodeId**。未知 id、别的 widget 的 id 一律拒收并计数 ——
//    Worker 侧的 id 是单调整数，如果不这张表守着，它就能靠猜 id 碰到别人的节点。
// 2. **名字白名单由 `isWidgetOp` 单点判**（widget-protocol.ts）。这里再判一套就会漂移成两套真相。
// 3. **回推的不是事件对象**。跨 realm 传事件对象既不可能也没意义，只挑本次事件真正要读的字段。
//
// 本文件只在宿主 realm 跑，但**不许** import `bridge.ts` / `@tauri-apps/*`：它收到的东西全部来自
// 一个不受信的 realm，能引到的宿主能力必须只有 DOM。
import { isWidgetOp, type HostToWidget, type WidgetOp } from "./widget-protocol";

/** 宿主回推的消息形状就是协议里那份 HostToWidget —— 不在这里另立一份，两份并集迟早漂移。 */
type WidgetInbound = HostToWidget;

export interface WidgetRenderer {
  /** 宿主侧唯一入口：一条批次里的 op 按顺序 apply，非法的整条拒收 */
  apply(ops: unknown[]): void;
  /** 被拒收的 op 计数（未知 id、非法形状）。运行时断言看的就是这个数 */
  rejects(): number;
  /** 拒绝次数越界后本 session 被关闭：插件刷 op 打不穿宿主 */
  closed(): boolean;
  destroy(): void;
}

export interface WidgetRendererOptions {
  /** 该 widget 自己的 closed Shadow Root（widget-host.ts 建的那个） */
  root: ShadowRoot;
  /** 尺寸观测对象：通常是挂位容器，不是 shadow 内部节点 */
  container: HTMLElement;
  pluginId: string;
  postMessage: (msg: WidgetInbound, transfer?: Transferable[]) => void;
}

/** 已交接给 Worker 的画布：主线程再碰它就等于两个 realm 同时持有一件资源 */
interface CanvasHandoff {
  handedOff: boolean;
  offscreen?: OffscreenCanvas;
}

/** 越界阈值：够把一次误用变成「这个 widget 被关掉」，又不至于让正常 widget 的偶发误写致命。 */
const REJECT_LIMIT = 64;

export function createWidgetRenderer(opts: WidgetRendererOptions): WidgetRenderer {
  const nodes = new Map<number, Element>();
  const listeners = new Map<number, Map<string, EventListener>>();
  const canvases = new Map<number, CanvasHandoff>();
  nodes.set(0, opts.root as unknown as Element);
  let rejected = 0;
  let destroyed = false;
  let closedFlag = false;

  /** 拆掉这个渲染器：断开尺寸观测、摘掉所有监听、丢掉节点表。
   *  声明在 reject 之前是因为越界关闭要用它（调用一定发生在整个装配完成之后）。 */
  const destroy = () => {
    destroyed = true;
    observer.disconnect();
    listeners.forEach((byEvent, id) => {
      const el = nodes.get(id);
      if (!el) return;
      byEvent.forEach((handler, event) => {
        el.removeEventListener(event, handler);
      });
    });
    listeners.clear();
    nodes.clear();
    canvases.clear();
  };

  /** 拒收一个 op：只计数 + debug 级线索，**不走 console.warn** —— 拒绝是本契约的正常路径，
   *  它的遥测要进宿主日志（下一片在 doMount 接缝里接），而不是把浏览器 console 刷成噪音；
   *  越界直接关闭本 session：非法洪水打不穿宿主。 */
  const reject = (why: string) => {
    if (destroyed) return;
    rejected += 1;
    if (rejected <= REJECT_LIMIT) console.debug(`[widget:${opts.pluginId}] 拒收 op: ${why}`);
    if (rejected === REJECT_LIMIT) {
      console.debug(`[widget:${opts.pluginId}] 拒绝次数越界，关闭本 widget session`);
      closedFlag = true;
      destroy();
    }
  };

  /** 事件快照：只挑这一类事件真正要读的字段，其余一概不带 */
  const snapshotOf = (event: string, raw: Event): Record<string, unknown> => {
    const target = raw.target as HTMLElement | null;
    if (event === "keydown") return { key: (raw as KeyboardEvent).key };
    if (event === "change" || event === "input") {
      const input = target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      return { value: input?.value ?? "", checked: (input as HTMLInputElement | null)?.checked === true };
    }
    return {};
  };

  const pushLayout = () => {
    if (destroyed) return;
    const measured: Record<string, { w: number; h: number }> = {};
    // 画布的两个尺寸都得宿主量了下发：Worker 侧没有 clientWidth / clientHeight。
    // 只给宽不够 —— K 线图的高不是常量（插件没写死 CSS 高度），只发宽就等于让它一直 fallback。
    for (const id of canvases.keys()) {
      const el = nodes.get(id) as HTMLCanvasElement | undefined;
      if (el) measured[String(id)] = { w: el.clientWidth, h: el.clientHeight };
    }
    opts.postMessage({
      t: "layout",
      width: opts.container.clientWidth,
      height: opts.container.clientHeight,
      dpr: window.devicePixelRatio,
      measured,
    });
  };

  const observer = new ResizeObserver(pushLayout);
  observer.observe(opts.container);

  const create = (op: Extract<WidgetOp, { k: "create" }>) => {
    // 命名空间只由 op.svg 决定。两张标签表在 isWidgetOp 那一层就不相交，
    // 所以这里不存在「名为 path 的未知 HTML 元素」那种幽灵节点，不需要兜底改写成 div
    const el = op.svg
      ? document.createElementNS("http://www.w3.org/2000/svg", op.tag)
      : document.createElement(op.tag);
    nodes.set(op.id, el);
    if (!op.svg && op.tag === "canvas") {
      const state: CanvasHandoff = { handedOff: false };
      canvases.set(op.id, state);
      // T18 实测：交接对未入文档的 canvas 也成立，所以这里可以直接交，等 append 进树后照样渲染。
      // 只能交一次，且交出去之后主线程不得再取上下文。
      const canvas = el as HTMLCanvasElement;
      if (typeof canvas.transferControlToOffscreen === "function") {
        try {
          state.offscreen = canvas.transferControlToOffscreen();
          state.handedOff = true;
          opts.postMessage({ t: "handoff", id: op.id, off: state.offscreen }, [state.offscreen]);
        } catch {
          // 某些实现会拒绝（已交接过、或上下文已被取走）：留主线程可画的 canvas，
          // widget 那边拿不到 handoff 会退回自己报错，而不是这里静悄悄
          state.handedOff = false;
        }
      }
    }
  };

  const applyOne = (op: WidgetOp) => {
    // `adopt` 与 `create` 是**引入** id 的 op，表里当然还没有它。把「目标节点必须已存在」这条
    // 无差别套在它们身上，等于一个 widget 的第一条 op 就被自己拒掉、整棵树建不起来
    //（这一条是真 shadow root 上跑出来的：14 个 op 全被拒、innerHTML 空）。
    if (op.k === "adopt") {
      nodes.set(op.id, opts.root as unknown as Element);
      return;
    }
    if (op.k === "create") {
      // 同一个 id 重复 create 一律拒：否则一个 Worker 可以拿老 id 换掉别人正在用的节点
      if (nodes.has(op.id)) {
        reject(`id 已被占用，不能重复 create id=${op.id}`);
        return;
      }
      create(op);
      return;
    }
    const targetId = op.k === "append" || op.k === "replace" ? op.parent : op.id;
    const el = nodes.get(targetId);
    if (!el) {
      // 未知 id：可能是猜的、可能是别的 widget 的、可能是本 session 已被 remove 的。一律不碰 DOM
      reject(`未知节点 id=${targetId} k=${op.k}`);
      return;
    }
    switch (op.k) {
      case "append": {
        const child = nodes.get(op.child);
        if (!child) {
          reject(`append 的子节点 id 不认识 ${op.child}`);
          return;
        }
        el.append(child);
        return;
      }
      case "replace": {
        const kids = op.children.map((id) => nodes.get(id)).filter((n): n is Element => !!n);
        if (kids.length !== op.children.length) reject("replace 里有不认识的子节点");
        el.replaceChildren(...kids);
        return;
      }
      case "remove":
        el.remove();
        listeners.get(op.id)?.forEach((handler, event) => {
          el.removeEventListener(event, handler);
        });
        listeners.delete(op.id);
        return;
      case "text":
        el.textContent = op.value;
        return;
      case "prop": {
        // 交接出去的画布归 Worker 持有，主线程一个属性都不写
        const handed = canvases.get(op.id);
        if (handed?.handedOff && (op.name === "width" || op.name === "height")) {
          reject("画布已交接，主线程不再写它的尺寸");
          return;
        }
        if (!(op.name in el)) {
          reject(`这类节点没有 property ${op.name}`);
          return;
        }
        (el as unknown as Record<string, unknown>)[op.name] = op.value;
        return;
      }
      case "attr":
        if (op.value === null) el.removeAttribute(op.name);
        else el.setAttribute(op.name, op.value);
        return;
      case "style": {
        const style = (el as HTMLElement).style;
        if (!style) {
          reject("非 HTML 元素没有 style");
          return;
        }
        for (const [name, value] of Object.entries(op.props)) {
          // CSSStyleDeclaration 没有字符串索引签名，但按名字写就是这套契约的样子
          (style as unknown as Record<string, string>)[name] = String(value);
        }
        return;
      }
      case "dataset": {
        const data = (el as HTMLElement).dataset;
        if (!data) {
          reject("非 HTML 元素没有 dataset");
          return;
        }
        if (op.value === null) delete data[op.key];
        else data[op.key] = op.value;
        return;
      }
      case "listen": {
        let byEvent = listeners.get(op.id);
        if (!byEvent) {
          byEvent = new Map();
          listeners.set(op.id, byEvent);
        }
        if (byEvent.has(op.event)) return;
        const handler: EventListener = (raw) => {
          if (op.preventDefault) raw.preventDefault();
          opts.postMessage({ t: "event", id: op.id, event: op.event, value: snapshotOf(op.event, raw) });
        };
        byEvent.set(op.event, handler);
        el.addEventListener(op.event, handler);
        return;
      }
      case "unlisten": {
        const byEvent = listeners.get(op.id);
        const handler = byEvent?.get(op.event);
        if (handler && byEvent) {
          el.removeEventListener(op.event, handler);
          byEvent.delete(op.event);
        }
        return;
      }
    }
  };

  return {
    apply(ops) {
      if (destroyed || closedFlag) return;
      for (const raw of ops) {
        if (!isWidgetOp(raw)) {
          reject(`非法 op 形状 ${JSON.stringify(raw)?.slice(0, 80)}`);
          continue;
        }
        applyOne(raw);
      }
      // 一批改完再量一次：ResizeObserver 只观测容器，shadow 内部的尺寸变化不会惊动它
      pushLayout();
    },
    rejects: () => rejected,
    closed: () => closedFlag,
    destroy,
  };
}
