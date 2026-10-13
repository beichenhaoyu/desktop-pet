// K2 标准 topic 常量的离线一致性单测。
//
// 落点分工（卡片口径）：唯一定义处是 packages/sdk/topics.js；插件本轮**继续写字面串**
// （插件经 petplugin:// 从磁盘加载，运行时导不到 packages/，见 T01 的 toolchain-blockers.md B4）。
// 所以「只定义一处」靠本文件的反向钉住保证：读插件源码、提取冒号 topic 字面串，
// 改 topics.js 或改插件任一边，本文件即红，不存在两边能各自漂走的窗口。
//
// 提取口径：被 " ' ` 三种引号之一**整串封边**的小写冒号 token（形如 word:word，允许点与连字符）。
// 只取整串 —— 句子中间提及 topic 的注释不会被误扫；判定是逐条成员检查而不是数量断言，
// 无关字符串不会把它搞红（卡片 §6）。
//
// 运行：npm run unit:sdk（也随 npm run unit 一起跑）
import { readdirSync, readFileSync } from "node:fs";
import { check, deep, eq, group } from "./harness.mjs";

const sdk = await import(new URL("../../packages/sdk/topics.js", import.meta.url));
const todoTopics = await import(new URL("../../plugins/todo/topics.js", import.meta.url));

/** AGENTS.md「约定」段的标准事件 topic 五条（K2 卡 §3 原文） */
const EXPECTED = ["ble:heart-rate", "agent:state", "agent:event", "llm:token-usage", "todo:changed"];

/** 宿主原生注入、但不在五条标准名单里的 BLE 事件（src/runtime/plugin-runtime.ts:244-247 的 listen 清单；
 * docs/plugin-dev/PLUGIN_SDK.md:111 把它们单列为标准事件名）。**钉死**在此：在这两个之外，插件源码里新增任何
 * 冒号 topic 都会红 —— 到时要么收进 topics.js，要么带着出处把名字加到这份清单（PM 裁决）。 */
const HOST_EXTRA_ALLOWED = Object.freeze(["ble:device-found", "ble:disconnected"]);

const SRC = {
  "hr-ble": new URL("../../plugins/com.pet.hr-ble/index.js", import.meta.url),
  "agent-bridge": new URL("../../plugins/com.pet.agent-bridge/index.js", import.meta.url),
  todo: new URL("../../plugins/todo/index.js", import.meta.url),
};
const read = (u) => readFileSync(u, "utf8");

/** 提取源码文本里被引号整串封边的冒号 topic 字面串（注释里带引号的整串也算现场，宁严勿漏） */
function topicLiterals(src) {
  const out = new Set();
  for (const m of src.matchAll(/["'`]([a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*)["'`]/g)) out.add(m[1]);
  return out;
}

const found = new Map(Object.entries(SRC).map(([k, u]) => [k, topicLiterals(read(u))]));
const allFound = new Set([...found.values()].flatMap((s) => [...s]));

/* ============================ 名单断言 ============================ */
group("标准 topic 名单");

// 顺序无关的集合比较（deep 按排序后的 JSON 串比；五个名字无重复值）
deep("STANDARD_TOPICS 恰好等于五个标准名（集合比较，顺序无关）", [...sdk.STANDARD_TOPICS].sort(), [...EXPECTED].sort());
eq("名单无重复项", new Set(sdk.STANDARD_TOPICS).size, EXPECTED.length);
check("名单已冻结（Object.freeze）", Object.isFrozen(sdk.STANDARD_TOPICS));
eq("BLE_HEART_RATE 的值", sdk.BLE_HEART_RATE, "ble:heart-rate");
eq("AGENT_STATE 的值", sdk.AGENT_STATE, "agent:state");
eq("AGENT_EVENT 的值", sdk.AGENT_EVENT, "agent:event");
eq("LLM_TOKEN_USAGE 的值", sdk.LLM_TOKEN_USAGE, "llm:token-usage");
eq("TODO_CHANGED 的值", sdk.TODO_CHANGED, "todo:changed");
eq("host:fullscreen 不是总线 topic，不在名单里", sdk.STANDARD_TOPICS.includes("host:fullscreen"), false);

/* ==================== 反向钉住：插件现场字面串 ==================== */
group("插件现场字面串都在名单内");

check(
  "提取器在 hr-ble 与 agent-bridge 上扫到了字面串（防提取口径失效造成的假绿）",
  found.get("hr-ble").size > 0 && found.get("agent-bridge").size > 0,
  `hr-ble=${[...found.get("hr-ble")].join(",")} agent-bridge=${[...found.get("agent-bridge")].join(",")}`,
);
for (const topic of [...allFound].sort()) {
  check(
    `现场字面串 ${topic} 在标准名单或钉死的宿主例外内`,
    sdk.STANDARD_TOPICS.includes(topic) || HOST_EXTRA_ALLOWED.includes(topic),
    `不在 STANDARD_TOPICS 也不在宿主例外 [${HOST_EXTRA_ALLOWED.join(", ")}] —— 新增未登记的冒号 topic 必须先登记`,
  );
}

/* ==================== 值一致：两侧字面串 ==================== */
group("现场字面串与常量逐条一致");

// subscribe 侧：插件字面串必须与 SDK 常量逐字相同（改插件或改常量，任一边都红）
eq("hr-ble 订阅用的是 BLE_HEART_RATE 的值", found.get("hr-ble").has(sdk.BLE_HEART_RATE), true);
eq("agent-bridge 订阅用的是 AGENT_STATE 的值", found.get("agent-bridge").has(sdk.AGENT_STATE), true);
eq("agent-bridge 订阅用的是 AGENT_EVENT 的值", found.get("agent-bridge").has(sdk.AGENT_EVENT), true);

// publish 侧：todo 的发布串来自插件自己的 topics.js 常量（`todo` 落在自己前缀里）
eq("todo 插件 TOPIC_CHANGED 的字面值 = SDK 的 TODO_CHANGED", todoTopics.TOPIC_CHANGED, sdk.TODO_CHANGED);
check(
  "todo/index.js 的发布点走 TOPIC_CHANGED 常量（发布侧没有可漂的字面串）",
  /bus\.publish\(\s*TOPIC_CHANGED\b/.test(read(SRC.todo)),
  "找不到 bus.publish(TOPIC_CHANGED) —— 发布点换了写法要同步本断言",
);

/* ==================== 归属规则 ==================== */
group("归属规则未被本卡破坏");

eq("todo:changed 落在 todo 插件自己的前缀内", sdk.TODO_CHANGED.startsWith(`${todoTopics.PID}:`), true);
check("llm:token-usage 在标准名单内（登记未使用，不是删掉）", sdk.STANDARD_TOPICS.includes(sdk.LLM_TOKEN_USAGE));

{
  // 现状：四个在售插件都没有用它（llm-token-usage 示例插件用户已暂缓）。
  // 将来谁先用上，这里变红是提醒登记消费方，不是禁令。只扫代码与 manifest（.js/.json）。
  const dir = new URL("../../plugins/", import.meta.url);
  const files = readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).replaceAll("\\", "/"))
    .filter((rel) => /\.(js|json)$/.test(rel));
  const users = files.filter((rel) => readFileSync(new URL(rel, dir), "utf8").includes(sdk.LLM_TOKEN_USAGE));
  eq("llm:token-usage 目前没有任何插件在用（「未使用」如实钉住）", users.length, 0);
}
