// L1 原型（ADR-0006）的离线契约单测：Worker 通道这张表就是插件的全部发言面。
//
// 三层钉法：
//   ① 表本身 —— 22 个名字逐条钉死，且每个叶子名都能在 packages/sdk/index.d.ts 里找到成员声明；
//   ② 宿主派发表完备 —— 20 个「纯参数进纯值出」的方法在 worker-plugin-host.ts 里必须逐条点名；
//   ③ 隔离前提 —— Worker 侧那两个文件里不许出现 @tauri-apps 或 host-error（一旦漏进去，
//      裸 IPC 就跟着 bundle 进了 Worker realm，本波要收口的洞当场作废）。
//
// 运行：npm run unit（随全量离线单测一起跑；真机那部分见 npm run verify:worker）
import { readFileSync } from "node:fs";
import { check, deep, eq, group } from "./harness.mjs";

const proto = await import(new URL("../../src/runtime/plugin-worker-protocol.ts", import.meta.url));
const { LEGACY_CODE } = await import(new URL("../../src/runtime/host-error.ts", import.meta.url));

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const sdkSrc = read("../../packages/sdk/index.d.ts");
const hostSrc = read("../../src/runtime/worker-plugin-host.ts");
const workerSrc = read("../../src/runtime/plugin-worker.ts");
const protoSrc = read("../../src/runtime/plugin-worker-protocol.ts");
const runtimeSrc = read("../../src/runtime/plugin-runtime.ts");
const sorted = (list) => [...list].sort();

/** ADR-0006 契约里那张 22 个方法的表，逐字钉死（改名、增删都要先改 ADR） */
const EXPECTED = [
  "agentHooks.install",
  "agentHooks.status",
  "agentHooks.uninstall",
  "ble.connect",
  "ble.connectedDevice",
  "ble.disconnect",
  "ble.startScan",
  "ble.stopScan",
  "bus.publish",
  "bus.subscribe",
  "http.request",
  "log",
  "notify.show",
  "overlay.destroy",
  "overlay.hide",
  "overlay.show",
  "pet.react",
  "pet.say",
  "storage.delete",
  "storage.get",
  "storage.set",
  "widget.update",
];

group("Worker 通道方法表");
deep("方法表恰好是既定的 22 个名字", sorted(proto.PLUGIN_WORKER_METHODS), EXPECTED);
eq("方法表条数", proto.PLUGIN_WORKER_METHODS.length, 22);
eq("方法表无重复", new Set(proto.PLUGIN_WORKER_METHODS).size, 22);
for (const name of EXPECTED) {
  const leaf = name === "log" ? "log" : name.split(".")[1];
  check(`SDK 类型面里有 "${leaf}("`, sdkSrc.includes(`${leaf}(`), `packages/sdk/index.d.ts 里找不到 ${leaf}(`);
}
check(
  "命名空间只落在 PluginContext 的那几个成员上",
  [...new Set(proto.PLUGIN_WORKER_METHODS.map((m) => m.split(".")[0]))].every((ns) =>
    ["bus", "storage", "ble", "widget", "pet", "http", "notify", "overlay", "agentHooks", "log"].includes(ns),
  ),
);

group("宿主派发表完备");
const proxied = EXPECTED.filter((name) => name !== "bus.subscribe" && name !== "log");
eq("表内需实现的方法数", proxied.length, 20);
for (const name of proxied) {
  check(`worker-plugin-host.ts 点名实现了 "${name}"`, hostSrc.includes(`"${name}":`), "派发表里没有这一条");
}
check("两个带函数的方法在 dispatch 里特判", hostSrc.includes('msg.method === "bus.subscribe"') && hostSrc.includes('msg.method === "log"'));

group("入站方法名判据");
for (const name of EXPECTED) {
  check(`"${name}" 被接受`, proto.isWorkerMethod(name) === true);
}
for (const bad of ["plugins_list", "permission_revoke", "constructor", "__proto__", "", "storage", "log.get"]) {
  check(`"${bad}" 被拒`, proto.isWorkerMethod(bad) === false);
}
for (const bad of [undefined, null, 42, {}, []]) {
  check(`非字符串方法名被拒（${JSON.stringify(bad)}）`, proto.isWorkerMethod(bad) === false);
}

group("错误负载过通道");
const codes = JSON.parse(read("../../packages/sdk/error-codes.json")).codes.map((c) => c.code);
eq("兜底码与 host-error 的 LEGACY_CODE 同值", proto.WORKER_LEGACY_CODE, LEGACY_CODE);
for (const code of codes) {
  check(`码表里的 "${code}" 原样通过`, proto.normalizeWorkerCode(code) === code);
}
eq("不在码表里的码退成兜底码", proto.normalizeWorkerCode("nope"), LEGACY_CODE);
eq("非字符串的码退成兜底码", proto.normalizeWorkerCode(undefined), LEGACY_CODE);
const rebuilt = proto.fromWorkerError({ code: "denied", message: "[zz.l1-probe] 权限被拒绝: storage" });
check("还原出来的是 Error 且名字是 HostError", rebuilt instanceof Error && rebuilt.name === "HostError");
eq("文案逐字不变", rebuilt.message, "[zz.l1-probe] 权限被拒绝: storage");
eq("码挂在 Error 上", rebuilt.code, "denied");

group("Worker 侧不得带进裸 IPC");
/** 只认「真的 import 语句」—— 注释里提到 @tauri-apps 是说明为什么不许用，不算违规 */
const importsTauri = (src) => /from\s+"@tauri-apps|import\(\s*"@tauri-apps/.test(src);
for (const [label, src] of [
  ["plugin-worker.ts", workerSrc],
  ["plugin-worker-protocol.ts", protoSrc],
]) {
  check(`${label} 不 import @tauri-apps`, !importsTauri(src));
  check(`${label} 不引用 host-error`, !src.includes('"./host-error"'));
  check(`${label} 不引用 invoke`, !src.includes("invoke("));
}
check("Worker 本体不碰 window.", !workerSrc.includes("window."));
check("宿主侧才 import 真实通道", hostSrc.includes('from "./host-error"'));

group("开关与接线");
eq("开关键名", proto.WORKER_HOST_FLAG, "host:worker-plugin-host");
check("名单为空 = 不走 Worker", proto.shouldUseWorkerHost("com.pet.todo", "") === false);
check("键缺失 = 不走 Worker", proto.shouldUseWorkerHost("com.pet.todo", null) === false);
check("别人的 id 不算", proto.shouldUseWorkerHost("com.pet.todo", "com.pet.hr-ble") === false);
check("逗号名单里命中", proto.shouldUseWorkerHost("com.pet.todo", "com.pet.hr-ble, com.pet.todo") === true);
check("只有探针时也命中", proto.shouldUseWorkerHost("zz.l1-probe", "zz.l1-probe") === true);
check("宠物窗按开关分流", runtimeSrc.includes("shouldUseWorkerHost(") && runtimeSrc.includes("workerHost()"));
check("启停两条路径都在", runtimeSrc.includes(".activate(manifest)") && runtimeSrc.includes(".deactivate(pluginId)"));
check("Worker 宿主的插件不再触发整页重载", runtimeSrc.includes("!workerHosted.has(id)"));
check(
  "plugin-runtime.ts 不在顶层 import Worker 宿主（`?worker` 说明符 node 解析不了）",
  !/\nimport \{ workerPluginHost \} from "\.\/worker-plugin-host"/.test(runtimeSrc),
);
