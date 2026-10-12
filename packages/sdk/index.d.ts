// Pet 插件 SDK 类型面（K1）。
//
// 两份契约面 —— 别合并，它们不是同一个 realm 里的东西：
// - PluginContext：宠物窗里 index.js 的 `activate(ctx)` 收到的对象，宿主实现是
//   src/runtime/bridge.ts 的 buildContext()（:110）。失败形态**一律 Promise reject**
//   （gated 的 throw 在 async 体内，bridge.ts:82-93）。
// - WidgetContext：widget.js 的 `mount(root, ctx)` 收到的对象，宿主注入实现是
//   src/runtime/widget-host.ts 的 doMount()（:91-105）。widget 侧总线方法是**同步函数**，
//   违规**同步 throw**（src/runtime/topic-acl.ts:43-55）；且 `ctx.host` 只在 settings 区存在
//   （widget-host.ts:97）。把两面合并等于给插件一把宠物窗里拿不到的钥匙。
//
// 行号为 2026-10-12 落笔时的现场；行为口径另见 PLUGIN_SDK.md 与 T01 取证报告
// （.dispatch/arch-p2/work/T01/sdk-surface.md）。

/** petdex 九状态名。词表来源 src/pet/petdex-states.ts:9-18（PetStateId），
 * src/pet/sprites.ts:22 把它别名为 ActionName；运行期白名单 src/pet/host.ts:9（PET_ACTIONS）。 */
export type PetAction =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

/** ctx.http.request 的响应。序列化形状来自 Rust `HttpResponse`
 * （src-tauri/src/services/http.rs:24-30，无 rename_all，字段按原名 snake_case 输出）。 */
export interface HttpResponse {
  status: number;
  /** 响应头 Content-Type 原值；宿主按它的 charset 解 gbk / gb2312 / gb18030，其余按 UTF-8 lossy（http.rs::decode_body） */
  content_type: string | null;
  body: string;
  /** body 超过上限被截断时为 true（http.rs:19、221-224，上限 1 MiB） */
  truncated: boolean;
}

/** ctx.http.request 的 options（bridge.ts:203） */
export interface HttpRequestOptions {
  method?: string;
  headers?: [string, string][];
  body?: string;
}

/** ctx.overlay.show 的 options（bridge.ts:233）。
 * height 实际被钳到 48~900、缺省 200（src-tauri/src/window/overlay.rs:82、84-86）；
 * placement 只认精确值 "above-pet"，其余字符串（含拼错）静默按桌面左上角（overlay.rs:261-265）。 */
export interface OverlayShowOptions {
  placement?: string;
  height?: number;
}

/** settings 区 widget 专属：ctx.host.agentHooks（bridge.ts:102-108，只经 widget-host.ts:97-105 注入，边界见 ADR-0001）。 */
export interface AgentHooksApi {
  /** Rust `agent_hooks_status` 的返回：{ exe, files, managed, installed, expectedPerFile }（src-tauri/src/commands/agent.rs:53-60）；失败 reject */
  status(): Promise<unknown>;
  /** Rust `agent_hooks_install` 的返回：{ files: reports }（agent.rs:85）；没找到 Qoder 配置目录时 reject（agent.rs:81-83） */
  install(): Promise<unknown>;
  /** Rust `agent_hooks_uninstall` 的返回：{ files: reports }（agent.rs:97）；失败 reject */
  uninstall(): Promise<unknown>;
}

/** 宠物窗桥侧总线（bridge.ts:122、128）。与 WidgetContext.bus 不同：这里全是 async，失败 reject。 */
export interface PluginBus {
  /** 只能发 `<自己 id>:` 前缀，且不能是通配（src/runtime/topic-acl.ts:9-14）。跨窗中继失败不 reject，只 console.error（src/runtime/event-bus.ts:36-38）。需要能力 `bus:publish` */
  publish(topic: string, payload: unknown): Promise<void>;
  /** 需要能力 `bus:subscribe`（不声明会在激活时被拒）。resolve 出退订函数；不手动退订则停用时由宿主回收（src/runtime/subscriptions.ts:12、plugin-runtime.ts:201） */
  subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** 宠物窗桥侧存储（bridge.ts:135-139；Rust services/store.rs，按插件 id 隔离落盘）。 */
export interface PluginStorage {
  /** 值是任意 JSON；**没写过的键 resolve 出 null**（store.rs:111，Result<Option<Value>>） */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 宠物窗桥侧 BLE（bridge.ts:141-172）。扫描与连接会话按插件持有者计数（src/runtime/resources.ts:12-25）：
 * 不是最后一个持有者时 stopScan / disconnect 静默成功、不发 IPC（bridge.ts:155、167）。 */
export interface PluginBle {
  /** 需要能力 `ble:scan`；失败会把持有者登记回滚（bridge.ts:148-151） */
  startScan(): Promise<void>;
  /** 需要能力 `ble:scan` */
  stopScan(): Promise<void>;
  /** 需要能力 `ble:connect`；失败回滚持有者（bridge.ts:161-164） */
  connect(deviceId: string): Promise<void>;
  /** 需要能力 `ble:connect` */
  disconnect(): Promise<void>;
  /** 需要能力 `ble:connect`；未连接时 resolve 出 null（Rust ble.rs:393-400，Option<String>） */
  connectedDevice(): Promise<string | null>;
}

/** 宠物窗里 `activate(ctx)` 收到的能力上下文（宿主实现 bridge.ts:110 buildContext）。
 * 权限按 manifest 逐项校验，拒绝默认（bridge.ts:82-93）；未授权的调用是 Promise reject。 */
export interface PluginContext {
  /** = manifest.id（bridge.ts:118） */
  readonly pluginId: string;
  /** 写 webview console，前缀 `[插件id]`；同步、不需要能力、永不 reject（bridge.ts:119） */
  log(...args: unknown[]): void;
  /** bridge.ts:121-133 */
  bus: PluginBus;
  /** bridge.ts:135-139 */
  storage: PluginStorage;
  /** bridge.ts:141-172；本机无蓝牙硬件，未经真实设备验证 */
  ble: PluginBle;
  /** 向自己的 widget 推数据，走 `<id>:widget` topic；需要能力 `widget`（bridge.ts:175-179） */
  widget: { update(data: unknown): Promise<void> };
  /** 影响宠物本体；本体只暴露这两个受控入口，不给 canvas/DOM（bridge.ts:181-197）。宠物本体未初始化时 reject */
  pet: {
    /** 参数只能是 petdex 九状态之一，其余名字会被桥拒绝（bridge.ts:184-186，白名单 src/pet/host.ts:9）。需要能力 `pet:react` */
    react(action: PetAction): Promise<void>;
    /** 弹一句台词：换行折叠成空格、trim、截 200 字；清洗后为空则 reject（bridge.ts:190-194）。需要能力 `pet:say` */
    say(text: string): Promise<void>;
  };
  /** 出站请求（bridge.ts:199-222）。桥里唯一不走 gated 的成员：权限判断是自己的
   * ensurePermissions(["http", "http:<host>"])（bridge.ts:211），一次弹框申请两个键。
   * 域名键不带默认端口（`https://x.com` 的键是 `x.com`）；重定向由宿主逐跳跟进并重新校验域名。 */
  http: { request(url: string, options?: HttpRequestOptions): Promise<HttpResponse> };
  /** 系统通知（bridge.ts:224-228）。静默改写：折叠空白、title 截 80 字、body 截 240 字；
   * 两者清洗后皆空时 reject（src-tauri/src/services/notify.rs:15-19、29-37）。需要能力 `notify` */
  notify: { show(title: string, body: string): Promise<void> };
  /** 本插件专属悬浮窗（bridge.ts:230-246），窗标签 overlay-<id>（id 里的点编码成下划线）。
   * 拒绝面：调用窗归属不对、或插件确实没装着（src-tauri/src/window/overlay.rs:247-260）。需要能力 `overlay` */
  overlay: {
    show(options?: OverlayShowOptions): Promise<void>;
    hide(): Promise<void>;
    /** 整扇销毁（overlay.rs:305-319）；插件停用时宿主也会收（plugin-runtime.ts:212 走 overlay_reclaim，不查 overlay 能力） */
    destroy(): Promise<void>;
  };
}

/** widget 的三个挂载区（PLUGIN_SDK.md:121-122；宿主调用点 plugin-runtime.ts:185、src/settings/main.ts:245、src/overlay/main.ts:39）。 */
export type WidgetRegion = "badge" | "overlay" | "settings";

/** widget 侧受限总线视图（src/runtime/topic-acl.ts:37-55 的 createScopedBus）。
 * 与宠物窗的 PluginBus **不是同一种返回形态**：这里是同步方法，违规**同步 throw**（不是 reject）；
 * 能力按 manifest 声明数组直接判断，不走授权表。 */
export interface WidgetBus {
  /** 违规（前缀不合法 / manifest 未声明 bus:publish）当场 throw（topic-acl.ts:43-50） */
  publish(topic: string, payload: unknown): void;
  /** 违规（通配越过自己前缀 / 订他人但未声明 bus:subscribe）当场 throw（topic-acl.ts:51-54、16-24） */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}

/** widget.js `mount(root, ctx)` 收到的上下文（宿主注入 widget-host.ts:91-105）。
 * 同一份 widget 文件会在 badge / overlay / settings 三个区分别挂载，按 `ctx.region` 区分行为。 */
export interface WidgetContext {
  /** = manifest.id（widget-host.ts:92） */
  readonly pluginId: string;
  /** 当前挂载区（widget-host.ts:93） */
  readonly region: WidgetRegion;
  /** topic-acl.ts:37-55 的受限视图（widget-host.ts:94 注入） */
  bus: WidgetBus;
  /** **仅 settings 区存在**（widget-host.ts:97-105）：badge / overlay 区是 undefined，
   * 宠物窗的 PluginContext 里根本没有这个键。 */
  host?: { agentHooks: AgentHooksApi };
}
