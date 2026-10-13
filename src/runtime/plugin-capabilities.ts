// K3：插件能力名的唯一来源（TS 侧入口）。
//
// 名单本体在 packages/sdk/plugin-capabilities.json —— Rust 侧 plugin_caps.rs 用
// include_str! 编译期内嵌同一份磁盘文件。这里 import 它（**必须带 import 属性**：
// 不带会在 node 单测里当场 ERR_IMPORT_ATTRIBUTE_MISSING，T02 探针实测），
// define() 在模块加载期校验成员资格（名字不在名单里直接炸）；名字集合与名单本体
// 的一致由 tests/unit/unit-capabilities.mjs 双向钉住。
import catalog from "../../packages/sdk/plugin-capabilities.json" with { type: "json" };

/** 名单本体（冻结；顺序与 docs/plugin-dev/PLUGIN_SDK.md §3 表格一致）。 */
export const CAPABILITIES: readonly string[] = Object.freeze([...catalog.capabilities]);

/** `http:<host>` 域名键的前缀（前缀型能力的元信息，与 Rust 侧同源）。 */
export const HTTP_HOST_PREFIX: string = catalog.httpHostPrefix;

function define(name: string): string {
  if (!CAPABILITIES.includes(name)) {
    throw new Error(`[plugin-capabilities] "${name}" 不在名单里 —— 名单是唯一来源，先改 JSON`);
  }
  return name;
}

export const BUS_PUBLISH = define("bus:publish");
export const BUS_SUBSCRIBE = define("bus:subscribe");
export const STORAGE = define("storage");
export const BLE_SCAN = define("ble:scan");
export const BLE_CONNECT = define("ble:connect");
export const WIDGET = define("widget");
export const OVERLAY = define("overlay");
export const HTTP = define("http");
export const NOTIFY = define("notify");
export const PET_REACT = define("pet:react");
export const PET_SAY = define("pet:say");
export const AGENT_HOOKS = define("agent:hooks");
