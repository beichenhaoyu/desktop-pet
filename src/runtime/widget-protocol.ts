// L2 阶段二：宿主 realm 与 widget Worker realm 之间的渲染契约（ADR-0008）。
//
// widget 的代码搬进 Worker 之后拿不到真的 ShadowRoot，只剩这一条通道；所以这里的每一张表
// 都是「插件能说的全部话」。闭集是刻意的：多一个名字等于扩大攻击面，少一个名字等于砸掉生态。
//
// 与 plugin-worker-protocol.ts 同一条铁律：这个文件两侧共用，**不许** import `host-error.ts`
// 或任何 `@tauri-apps/*` —— 一旦被 Worker 侧拉到，widget Worker 的 bundle 里就会躺着真正的
// IPC 入口，隔离当场作废。
//
// 词表不是设计出来的，是数出来的：每个 op kind、每个标签、每个属性与事件名都对应 2026-10-15
// 对四个示例插件 widget 图（15 个文件）的一次实测扫描。T16 那张固定 token 表漏了
// `setAttribute`(13) / `.value=`(13) / `.checked=`(11) / `.type=`(10) / `replaceChildren`(8) /
// `createElement("style")`(8) 这些真实形状，所以本文件按实测重写，而不是照它的 14 个桶落地。
import { isWorkerMethod } from "./plugin-worker-protocol";

/* ============ 标签与名字：全部闭集 ============ */

/** HTML 标签白名单。逐个对应实测次数：div 19 / style 8 / span 4 / i 2 / option 1 / label 1 /
 *  input 1 / canvas 1 / button 1；ul/li/p/h3/small/img 是 `innerHTML` 那一处改写要落地的结构，
 *  随迁移卡逐条加，不加注释里的任何一个（`a` / `form` / `iframe` / `object` / `link` / `meta` /
 *  `base` / `script` 一律不开：前四个能造成导航或资源加载，后四个是文档级标记，本就不该出现在插件手里）。 */
export const WIDGET_HTML_TAGS = [
  "div",
  "span",
  "i",
  "p",
  "small",
  "b",
  "label",
  "button",
  "input",
  "option",
  "select",
  "textarea",
  "ul",
  "li",
  "canvas",
  "style",
] as const;

/** SVG 标签白名单：hr-ble 那颗心用到的 5 个（svg / path / defs / linearGradient / stop），
 *  g / circle / rect / line / polyline 是给后续图表留的同族，其余 SVG 元素要随用例再开。 */
export const WIDGET_SVG_TAGS = [
  "svg",
  "g",
  "path",
  "defs",
  "linearGradient",
  "stop",
  "circle",
  "rect",
  "line",
  "polyline",
] as const;

/** 反向事件通道的事件名白名单（实测：click 6 / change 6 / keydown 1）。
 *  `input` 是同族里唯一值得预开的（文本框边打字边收，迁移时不然要改两次）。
 *  `window` 级的 resize / dpr **不在这里** —— 那走 `layout` 推送（ADR-0008 决策 4）。 */
export const WIDGET_EVENTS = ["click", "change", "input", "keydown"] as const;

/** 可写的 DOM property 名（不是 attribute！`.value` / `.checked` 写进 attribute 不会生效，
 *  这是 widget 里最大的一类真实用法：value 13 / checked 11 / type 10 / placeholder 4）。 */
export const WIDGET_PROPS = [
  "value",
  "checked",
  "disabled",
  "placeholder",
  "type",
  "id",
  "readOnly",
] as const;

/** 可写的 attribute 名。HTML 侧只有这几个是实测用到的；其余全是 SVG 呈现属性
 *  （stop-color / offset / x1 / y1 / x2 / y2 / viewBox / fill / d / class / id）。
 *  不开放 `style` 属性（走 `style` op 批量下发，逐属性写会放大消息数），不开 `src` / `href`
 *  （那是资源加载与导航能力，不在渲染契约里）。`title` 两张表都不开：全库实测 0 处使用。 */
export const WIDGET_ATTRS = [
  "id",
  "class",
  "width",
  "height",
  "viewBox",
  "d",
  "fill",
  "stroke",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "offset",
  "stop-color",
  "stop-opacity",
  "opacity",
  "points",
  "preserveAspectRatio",
  "transform",
] as const;

/** 可写的 CSS 属性（实测 13 处逐属性赋值，全在这张表或它的同族里）。用驼峰名，宿主侧直接写
 *  `el.style[name]`，不做 kebab 转换 —— 转换要引正则、多一处能出错的地方。 */
export const WIDGET_STYLE_PROPS = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxHeight",
  "display",
  "flex",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "gap",
  "padding",
  "margin",
  "color",
  "background",
  "backgroundColor",
  "border",
  "borderRadius",
  "opacity",
  "overflow",
  "overflowY",
  "fontSize",
  "fontWeight",
  "textAlign",
  "transform",
  "transformOrigin",
  "transition",
  "cursor",
  "whiteSpace",
  "visibility",
  "position",
  "top",
  "left",
  "zIndex",
  "aspectRatio",
  "animation",
] as const;

/** 明确**没有** `html` / `innerHTML` op：开它就等于把「插件可以注入任意标记」这条既有边界重新打开
 *  （AGENTS.md 的安全边界共识）。全库只有 1 处模板字符串（`plugins/com.pet.hr-ble/widget.js:293`），
 *  迁移时改成结构化 ops。这条事实由 `tests/unit/unit-widget-protocol.mjs` 钉住，不靠文档自觉。 */

/* ============ op 词表 ============ */

export const WIDGET_OP_KINDS = [
  "adopt", // 把一个已存在的宿主节点纳入本 session 的 id 表（root 用）
  "create", // { id, tag, svg? }
  "append", // { parent, child }
  "replace", // { parent, children[] } —— 实测 replaceChildren 8 处，列表重绘靠它
  "remove", // { id }
  "text", // { id, value }
  "prop", // { id, name, value }
  "attr", // { id, name, value }
  "style", // { id, props: { name: value } } —— 一条 op 批量下发，不逐属性发
  "dataset", // { id, key, value }
  "listen", // { id, event, preventDefault? }
  "unlisten", // { id, event }
] as const;

export type WidgetOpKind = (typeof WIDGET_OP_KINDS)[number];

export type WidgetOp =
  | { k: "adopt"; id: number; root: true }
  | { k: "create"; id: number; tag: string; svg?: true }
  | { k: "append"; parent: number; child: number }
  | { k: "replace"; parent: number; children: number[] }
  | { k: "remove"; id: number }
  | { k: "text"; id: number; value: string }
  | { k: "prop"; id: number; name: string; value: string | number | boolean | null }
  | { k: "attr"; id: number; name: string; value: string | null }
  | { k: "style"; id: number; props: Record<string, string | number> }
  | { k: "dataset"; id: number; key: string; value: string | null }
  | { k: "listen"; id: number; event: string; preventDefault?: true }
  | { k: "unlisten"; id: number; event: string };

/** 单条消息的 op 上限：超限由 Worker 侧切成连续多条（同一通道有序，宿主按 seq 校验没被打乱）。 */
export const WIDGET_MAX_OPS_PER_MESSAGE = 512;

/* ============ 消息形状 ============ */

/** 宿主 → widget Worker。 */
export type HostToWidget =
  | {
      t: "boot";
      pluginId: string;
      entryUrl: string;
      region: "badge" | "overlay" | "settings";
      permissions: string[];
    }
  /** 尺寸 / dpr / 宿主量到的关键节点尺寸。Worker 侧没有 window，重绘时机只能由这条驱动。 */
  | { t: "layout"; width: number; height: number; dpr: number; measured: Record<string, number> }
  /**
   * 画布所有权交接（T18 实测成立，Edg/155.0.4283.45：未入文档与已入文档两种 canvas 都能交出控制权，
   * Worker 内取 2d 上下文填满纯色后 `getImageData` 读回中心像素逐数相等）。
   * `off` 是真 OffscreenCanvas，只能由宿主用 `worker.postMessage(msg, [off])` 的 transfer 列表发过来；
   * **交接之后主线程不能再对该 canvas 取上下文**，所以这条消息每块画布只发一次。
   * 它是 inbound 而不是新的 op kind：词表那 12 个名字描述的是「怎么改树」，这里是「把一件宿主资源交出去」。
   */
  | { t: "handoff"; id: number; off: unknown }
  /** 反向事件：`value` 只允许标量或纯对象快照，永远不是事件对象本身。 */
  | { t: "event"; id: number; event: string; value: unknown }
  | { t: "deactivate" };

/** widget Worker → 宿主。`call` 复用能力调用通道（名字必须是 22 表里的）。 */
export type WidgetToHost =
  | { t: "ops"; seq: number; ops: WidgetOp[] }
  | { t: "call"; seq: number; method: string; args: unknown[] }
  | { t: "booted" }
  | { t: "boot-failed"; error: { code: string; message: string } }
  | { t: "deactivated" };

/* ============ 校验器（宿主侧 apply 之前必须逐条过） ============ */

const inSet = <T extends string>(table: readonly T[], value: string): value is T =>
  (table as readonly string[]).includes(value);

export const isWidgetOpKind = (value: unknown): value is WidgetOpKind =>
  typeof value === "string" && inSet(WIDGET_OP_KINDS, value);

export const isWidgetTag = (value: unknown): boolean =>
  typeof value === "string" &&
  (inSet(WIDGET_HTML_TAGS, value) || inSet(WIDGET_SVG_TAGS, value));

export const isWidgetEvent = (value: unknown): value is (typeof WIDGET_EVENTS)[number] =>
  typeof value === "string" && inSet(WIDGET_EVENTS, value);

export const isWidgetProp = (value: unknown): value is (typeof WIDGET_PROPS)[number] =>
  typeof value === "string" && inSet(WIDGET_PROPS, value);

export const isWidgetAttr = (value: unknown): value is (typeof WIDGET_ATTRS)[number] =>
  typeof value === "string" && inSet(WIDGET_ATTRS, value);

export const isWidgetStyleProp = (value: unknown): value is (typeof WIDGET_STYLE_PROPS)[number] =>
  typeof value === "string" && inSet(WIDGET_STYLE_PROPS, value);

/** 一条消息是不是本契约认的合法 outbound。宿主侧收到非法消息应当直接丢弃并记日志，
 *  而不是抛 —— 抛在 onmessage 里会变成一条无法归因的未捕获异常。 */
export function isWidgetToHost(msg: unknown): msg is WidgetToHost {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case "ops":
      return typeof m.seq === "number" && Array.isArray(m.ops) && m.ops.every(isWidgetOp);
    case "call":
      return typeof m.seq === "number" && typeof m.method === "string" &&
        isWorkerMethod(m.method) && Array.isArray(m.args);
    case "booted":
    case "deactivated":
      return true;
    case "boot-failed": {
      const e = m.error as Record<string, unknown> | undefined;
      return !!e && typeof e.code === "string" && typeof e.message === "string";
    }
    default:
      return false;
  }
}

/** 单个 op 的形状 + 名字检查：kind 在闭集里、必填字段齐且类型对、**名字也必须落在对应白名单里**。
 *  这里是唯一的权威门禁 —— 宿主侧 apply 之前过一遍就够，别再在别处补第二套判断（两套判断迟早会漂移，
 *  `check:shape` 的 S3 升拦之前就是因为有两个判断点）。 */
export function isWidgetOp(op: unknown): op is WidgetOp {
  if (!op || typeof op !== "object") return false;
  const o = op as Record<string, unknown>;
  if (!isWidgetOpKind(o.k)) return false;
  const num = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  const str = (v: unknown) => typeof v === "string";
  switch (o.k) {
    case "adopt":
      return num(o.id) && o.root === true;
    case "create": {
      if (!num(o.id) || !str(o.tag)) return false;
      // svg 标记决定用哪张标签表：SVG 的 `path` 与 HTML 的标签名空间不同，混着允许等于开出第二个命名空间
      return o.svg === true ? inSet(WIDGET_SVG_TAGS, o.tag) : inSet(WIDGET_HTML_TAGS, o.tag);
    }
    case "append":
      return num(o.parent) && num(o.child);
    case "replace":
      return num(o.parent) && Array.isArray(o.children) && o.children.every(num);
    case "remove":
      return num(o.id);
    case "text":
      return num(o.id) && str(o.value);
    case "prop":
      return (
        num(o.id) &&
        isWidgetProp(o.name) &&
        (o.value === null || str(o.value) || typeof o.value === "number" || typeof o.value === "boolean")
      );
    case "attr":
      return num(o.id) && isWidgetAttr(o.name) && (o.value === null || str(o.value));
    case "dataset":
      return num(o.id) && str(o.key) && (o.value === null || str(o.value));
    case "style": {
      if (!num(o.id) || !o.props || typeof o.props !== "object") return false;
      return Object.entries(o.props as Record<string, unknown>).every(
        ([k, v]) =>
          isWidgetStyleProp(k) &&
          (str(v) || (typeof v === "number" && Number.isFinite(v)) || v === null),
      );
    }
    case "listen":
      return (
        num(o.id) &&
        isWidgetEvent(o.event) &&
        (o.preventDefault === undefined || o.preventDefault === true)
      );
    case "unlisten":
      return num(o.id) && isWidgetEvent(o.event);
  }
}
