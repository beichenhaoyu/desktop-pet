// 标准事件 topic 的唯一定义处（K2）。
//
// 为什么是 .js + 同名 .d.ts 两份：单测与回归脚本是普通 node 跑的 .mjs，导不进 .ts；
// TS 侧（packages/sdk/index.d.ts）靠伴生 .d.ts 取字面量类型，不用开 allowJs。
//
// 插件本轮**继续用字面串**：插件经 petplugin:// 从磁盘加载，运行时导不到 packages/
// （裸包名解析不出，见 .dispatch/arch-p2/work/T01/toolchain-blockers.md B4），
// 收口留给 K5 / L1。因此「只定义一处」靠反向钉住实现 ——
// tests/unit/unit-sdk-topics.mjs 读插件源码、提取冒号 topic 字面串，
// 改这里或改插件任一边，测试即红。
//
// 名单来源：AGENTS.md「约定」段的标准事件 topic 五条。刻意不收的：
// host:fullscreen（宿主窗口事件，不是总线 topic），以及宿主原生注入的 BLE 扩展事件
// ble:device-found / ble:disconnected / ble:error（docs/PLUGIN_SDK.md 单列，不在五条标准里）。
export const BLE_HEART_RATE = "ble:heart-rate";
export const AGENT_STATE = "agent:state";
export const AGENT_EVENT = "agent:event";
export const LLM_TOKEN_USAGE = "llm:token-usage";
export const TODO_CHANGED = "com.pet.todo:changed";

/** 全部标准 topic（冻结数组，顺序与应用无关）。 */
export const STANDARD_TOPICS = Object.freeze([
  BLE_HEART_RATE,
  AGENT_STATE,
  AGENT_EVENT,
  LLM_TOKEN_USAGE,
  TODO_CHANGED,
]);

/* 宿主 BLE 服务经 `bus.inject` 注入的扩展事件（src/runtime/plugin-runtime.ts 的 listen 清单）。
   它们不在五条标准名单里（docs/PLUGIN_SDK.md 单列），但同样是「插件可订的宿主 topic」。 */
export const BLE_DEVICE_FOUND = "ble:device-found";
export const BLE_DISCONNECTED = "ble:disconnected";
export const BLE_ERROR = "ble:error";

/**
 * 插件**可以跨命名空间订阅**的公开 topic（ADR-0011）。
 *
 * 判据：订阅 `<别人 id>:xxx` 一律拒，只有这份名单里的名字才放行（仍需声明 `bus:subscribe`）。
 * 名单 = 五条标准 topic ∪ 宿主 BLE 扩展事件。宿主 inject 的就是全部来源，所以
 * ——新增一条宿主 topic 时要同步加到这里，否则插件订不到。**这是有意的**：
 * 漏登记会当场表现为「订不到」，而不是默默放开某个别人插件的私有 topic。
 * 注意名单里 `com.pet.todo:changed` 虽然长在插件前缀里，但它是登记为公开的标准 topic。
 */
export const PUBLIC_TOPICS = Object.freeze([
  ...STANDARD_TOPICS,
  BLE_DEVICE_FOUND,
  BLE_DISCONNECTED,
  BLE_ERROR,
]);
