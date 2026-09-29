// 插件内共享的 topic 常量：index.js 与 widget.js 各自 import 同一份，
// 避免两个文件里写死同一个字符串（第三方最容易照抄错的第一处）。
// 插件文件由宿主经 petplugin 协议按目录提供，相对 import 在 dev 与打包版都能解析。
export const PID = "com.pet.hr-ble";
export const TOPIC_CMD = `${PID}:cmd`;
export const TOPIC_BPM = `${PID}:bpm`;
export const TOPIC_DEVICES = `${PID}:devices`;
export const TOPIC_STATUS = `${PID}:status`;
