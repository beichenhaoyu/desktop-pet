// topic 常量：index.js 与 widget.js 共用一份，别在两个文件里各写一遍字符串。
export const PID = "com.pet.astock";

/** 插件给自己界面看的展示数据（宿主会为 `*:widget` 保留最近一份并回灌） */
export const TOPIC_WIDGET = `${PID}:widget`;
/** 设置页 → 主逻辑的指令 */
export const TOPIC_CMD = `${PID}:cmd`;
/** 主逻辑 → 界面的状态行 */
export const TOPIC_STATUS = `${PID}:status`;
/** 每轮刷新后的行情快照 */
export const TOPIC_QUOTE = `${PID}:quote`;
/** 自选股增删改 */
export const TOPIC_CHANGED = `${PID}:changed`;
/** 触发了提醒（到价 / 涨跌幅 / 涨跌停） */
export const TOPIC_ALERT = `${PID}:alert`;
/** 搜索候选（代码/名称 → secid），由主逻辑代查后回给设置页 */
export const TOPIC_SUGGEST = `${PID}:suggest`;
