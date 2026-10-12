// topics.js 的类型伴生（K2）。值以 topics.js 为准，这里的字面量必须与它逐字相同；
// 两侧的一致性由 tests/unit/unit-sdk-topics.mjs 钉住（js 运行时值 + 本文件的字面量类型
// 都引用同一批名字，改任一处都会在 tsc 或单测里现形）。
//
// 收进名单的只有 AGENTS.md「约定」段的五条标准事件 topic；宿主窗口事件 host:fullscreen
// 不是总线 topic，BLE 扩展事件（ble:device-found 等）不在五条内，都不在这里。

/** 心跳数据（宿主 BLE 服务广播，插件经总线订阅）。 */
export const BLE_HEART_RATE: "ble:heart-rate";
/** 编码 Agent 的会话总状态（running / needs_input / completed / idle，只在变化时广播，带递增 counter）。 */
export const AGENT_STATE: "agent:state";
/** 单条 hook 事件（phase / toolName / detail / steps / title，每次工具调用都发）。 */
export const AGENT_EVENT: "agent:event";
/** LLM token 用量（登记中：llm-token-usage 示例插件暂缓，尚无发布方与订阅方）。 */
export const LLM_TOKEN_USAGE: "llm:token-usage";
/** 待办清单变化（todo 插件发布，落在它自己的前缀内）。 */
export const TODO_CHANGED: "todo:changed";

/** 标准 topic 的联合类型。注意：总线 topic 参数**不收紧**成它 —— 私有 topic
 * （`<自己 id>:xxx`、`<自己 id>:widget`）必须继续合法，见 index.d.ts 的 BusTopic。 */
export type StandardTopic =
  | typeof BLE_HEART_RATE
  | typeof AGENT_STATE
  | typeof AGENT_EVENT
  | typeof LLM_TOKEN_USAGE
  | typeof TODO_CHANGED;

/** 冻结的标准 topic 名单（顺序与应用无关）。 */
export const STANDARD_TOPICS: readonly StandardTopic[];
