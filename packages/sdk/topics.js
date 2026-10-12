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
// ble:device-found / ble:disconnected / ble:error（PLUGIN_SDK.md 单列，不在五条标准里）。
export const BLE_HEART_RATE = "ble:heart-rate";
export const AGENT_STATE = "agent:state";
export const AGENT_EVENT = "agent:event";
export const LLM_TOKEN_USAGE = "llm:token-usage";
export const TODO_CHANGED = "todo:changed";

/** 全部标准 topic（冻结数组，顺序与应用无关）。 */
export const STANDARD_TOPICS = Object.freeze([
  BLE_HEART_RATE,
  AGENT_STATE,
  AGENT_EVENT,
  LLM_TOKEN_USAGE,
  TODO_CHANGED,
]);
