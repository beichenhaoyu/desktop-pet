// 插件内共享的 topic 常量：index.js 与 widget.js 各自 import 同一份。
// 插件 id 就叫 `todo`，所以 `todo:changed` 落在自己的命名空间里，能直接发布
// （AGENTS.md 把它列为标准 topic，这里正是那个约定）。
export const PID = "todo";
export const TOPIC_CMD = `${PID}:cmd`;
export const TOPIC_STATUS = `${PID}:status`;
export const TOPIC_WIDGET = `${PID}:widget`;
/// 标准 topic：别人（或后续插件）想知道清单变了没，订这个
export const TOPIC_CHANGED = `${PID}:changed`;
