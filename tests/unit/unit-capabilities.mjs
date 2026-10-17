// K3 插件能力名单一来源的离线一致性单测。
//
// 唯一来源：packages/sdk/plugin-capabilities.json。
//   * Rust 侧：src-tauri/src/plugin_caps.rs 用 include_str! 编译期内嵌同一份磁盘文件；
//   * TS 侧：src/runtime/plugin-capabilities.ts 用带 import 属性的 import 读它。
//
// 本文件做两层钉住（只测名单远远不够，见 T02 §4）：
//   ① 四条「JSON 收不掉的规则」各自留正反用例 —— http 的或/与两条判定、`<id>:widget`
//      由 widget 能力代发、`:widget` 回灌、topic 前缀归属；每条都把两侧（TS 实况代码 /
//      Rust 源码文本）与测试里的参考实现对上。
//   ② 反向钉住 —— 读两侧源码提取门禁位置出现的能力名，断言都在名单里；TS 侧门禁点
//      只许引用共享常量（不许裸字面量），Rust 侧只许引用 plugin_caps:: 的 const/函数。
//      改名单或改门禁点任何一边，本文件即红。
//
// 运行：npm run unit:capabilities（也随 npm run unit 一起跑）
import { readFileSync, readdirSync } from "node:fs";
import { check, deep, eq, group, throws } from "./harness.mjs";
import { calls as tauriCalls, resetStub, setReply } from "./tauri-stub.mjs";

const capsFile = JSON.parse(
  readFileSync(new URL("../../packages/sdk/plugin-capabilities.json", import.meta.url), "utf8"),
);
const capsMod = await import(new URL("../../src/runtime/plugin-capabilities.ts", import.meta.url));
const acl = await import(new URL("../../src/runtime/topic-acl.ts", import.meta.url));
const { bus } = await import(new URL("../../src/runtime/event-bus.ts", import.meta.url));
const { buildContext, createAgentHooksApi, invalidatePermissions } = await import(
  new URL("../../src/runtime/bridge.ts", import.meta.url)
);

/** 卡片 §3 定死的 12 名（与 plugin_caps.rs 单测的 EXPECTED 同源）；比较一律先排序、顺序无关 */
const EXPECTED = [
  "bus:publish",
  "bus:subscribe",
  "storage",
  "ble:scan",
  "ble:connect",
  "widget",
  "overlay",
  "http",
  "notify",
  "pet:react",
  "pet:say",
  "agent:hooks",
];

const sorted = (arr) => [...arr].sort();

/* ============================ 名单本体（唯一来源） ============================ */
group("名单本体");

check("plugin-capabilities.json 有 capabilities 数组", Array.isArray(capsFile.capabilities));
eq("名单恰好 12 个名字", capsFile.capabilities.length, 12);
eq("名单无重复项", new Set(capsFile.capabilities).size, 12);
deep("名单等于既定 12 名（集合比较，顺序无关）", sorted(capsFile.capabilities), sorted(EXPECTED));
eq("httpHostPrefix 是 http 的冒号后缀", capsFile.httpHostPrefix, `${capsMod.HTTP}:`);
eq("httpHostPrefix 恰为 http:", capsFile.httpHostPrefix, "http:");

// TS 侧模块的 12 个导出必须逐字落回名单（改 define 参数或改 JSON，任一边都红）
deep(
  "TS 模块 12 个命名常量逐字等于名单",
  sorted([
    capsMod.BUS_PUBLISH,
    capsMod.BUS_SUBSCRIBE,
    capsMod.STORAGE,
    capsMod.BLE_SCAN,
    capsMod.BLE_CONNECT,
    capsMod.WIDGET,
    capsMod.OVERLAY,
    capsMod.HTTP,
    capsMod.NOTIFY,
    capsMod.PET_REACT,
    capsMod.PET_SAY,
    capsMod.AGENT_HOOKS,
  ]),
  sorted(EXPECTED),
);
deep("CAPABILITIES 冻结集合等于名单本体", sorted(capsMod.CAPABILITIES), sorted(capsFile.capabilities));
check("CAPABILITIES 已冻结", Object.isFrozen(capsMod.CAPABILITIES));

/* ======================= http：或规则（声明层）正反用例 ======================= */
group("http 放宽规则·或（permission.rs，声明 http 覆盖 http:<host>）");

/** 参考实现：与 permission.rs::undeclared_caps 同形（名字与前缀取自名单本体导出） */
const undeclaredRule = (declared, requested) =>
  requested.filter((c) => !declared.some((d) => d === c || (d === capsMod.HTTP && c.startsWith(capsMod.HTTP_HOST_PREFIX))));

deep(
  "正例：声明 http 后请求任意 http:<host> 都不算未声明",
  undeclaredRule([capsMod.HTTP], [`${capsMod.HTTP_HOST_PREFIX}any.example`, `${capsMod.HTTP_HOST_PREFIX}other.example`]),
  [],
);
deep(
  "反例：只声明具体域名键，不覆盖别的域名",
  undeclaredRule([`${capsMod.HTTP_HOST_PREFIX}x.example`], [`${capsMod.HTTP_HOST_PREFIX}y.example`]),
  [`${capsMod.HTTP_HOST_PREFIX}y.example`],
);
deep("反例：没声明 http 时 http:<host> 就是未声明", undeclaredRule([], [`${capsMod.HTTP_HOST_PREFIX}a.example`]), [
  `${capsMod.HTTP_HOST_PREFIX}a.example`,
]);
deep("反例：其余能力精确匹配，不做前缀放宽", undeclaredRule([capsMod.STORAGE], [capsMod.NOTIFY, capsMod.STORAGE]), [
  capsMod.NOTIFY,
]);

/* ======================= http：与规则（放行层）正反用例 ======================= */
group("http 放宽规则·与（http.rs，放行要 http 与具体域名键同时在手）");

/** 参考实现：与 http.rs::host_allowed 同形（键的拼法 = 前缀 + host） */
const hostAllowedRule = (granted, host) =>
  granted.some((c) => c === capsMod.HTTP) && granted.some((c) => c === `${capsMod.HTTP_HOST_PREFIX}${host}`);

eq("正例：http + 具体域名键双在，放行", hostAllowedRule([capsMod.HTTP, `${capsMod.HTTP_HOST_PREFIX}x.example`], "x.example"), true);
eq("反例：只有 http 没有域名键，不放行", hostAllowedRule([capsMod.HTTP], "x.example"), false);
eq("反例：只有域名键没有 http，不放行", hostAllowedRule([`${capsMod.HTTP_HOST_PREFIX}x.example`], "x.example"), false);
eq("反例：别的域名键不放行这个 host", hostAllowedRule([capsMod.HTTP, `${capsMod.HTTP_HOST_PREFIX}x.example`], "y.example"), false);

/* ================== http：两侧源码的实现形状与桥的请求键 ================== */
group("http：Rust 两处判定与 TS 桥的键两侧一致");

const rustSrc = (rel) => readFileSync(new URL(`../../src-tauri/src/${rel}`, import.meta.url), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

// 参考实现侧（上面两组用例）依赖的元信息必须来自名单本体本身
eq("参考实现用的前缀来自名单本体", capsMod.HTTP_HOST_PREFIX, capsFile.httpHostPrefix);
eq("参考实现用的 http 名来自名单本体", capsMod.HTTP, capsFile.capabilities.find((c) => c === "http"));

// Rust 侧：解析 plugin_caps.rs 的编译期 const 表（UPPER 名 → 值），供各处引用解析用
const capsRsPath = new URL("../../src-tauri/src/plugin_caps.rs", import.meta.url);
const capsRs = readFileSync(capsRsPath, "utf8");
const rustConsts = new Map();
for (const m of capsRs.matchAll(/pub const ([A-Z_0-9]+): &str = "([^"]*)";/g)) {
  rustConsts.set(m[1], m[2]);
}
eq("plugin_caps.rs 的编译期 const 恰好 9 个（其余三条只在 webview 内判定）", rustConsts.size, 9);
for (const [name, value] of rustConsts) {
  check(`rust const ${name} 的值在名单里`, capsFile.capabilities.includes(value), `值 ${value}`);
}
const RUST_FNS = new Set(["http_host_prefix", "http_host_key"]);

// 与规则（http.rs）：先按 http_host_key 拼键，再要求 http 与键双在（&&，不是 ||）
const andRule = flat(rustSrc("services/http.rs")).match(
  /let cap = crate::plugin_caps::([a-z_]+)\(host\); granted\.iter\(\)\.any\(\|c\| c == crate::plugin_caps::([A-Z_]+)\) && granted\.iter\(\)\.any\(\|c\| c == &cap\)/,
);
check("http.rs 的与规则形状可得（防提取口径失效）", andRule !== null);
if (andRule) {
  eq("与规则：键由 http_host_key 拼出（唯一拼法）", andRule[1], "http_host_key");
  eq("与规则：要求 http 总开关", rustConsts.get(andRule[2]), "http");
}

// 或规则（permission.rs）：声明 http 直接覆盖任何 http: 前缀请求（|| 之外的原样精确匹配不动）
const orRule = flat(rustSrc("services/permission.rs")).match(
  /any\(\|d\| \{ d == \*c \|\| \(d == crate::plugin_caps::([A-Z_]+) && c\.starts_with\(crate::plugin_caps::([a-z_]+)\(\)\)\) \}\)/,
);
check("permission.rs 的或规则形状可得（防提取口径失效）", orRule !== null);
if (orRule) {
  eq("或规则：声明项等于 http", rustConsts.get(orRule[1]), "http");
  eq("或规则：前缀取自 http_host_prefix()", orRule[2], "http_host_prefix");
}

// TS 桥：请求的键集必须与与规则要求的键集同形（http + 前缀拼 host）
const bridgeSrc = flat(readFileSync(new URL("../../src/runtime/bridge.ts", import.meta.url), "utf8"));
const httpPair = bridgeSrc.match(/ensurePermissions\(manifest, \[([A-Za-z_]+), `\$\{([A-Za-z_]+)\}\$\{host\}`\]\)/);
check("桥的 http 授权申请形状可得（防提取口径失效）", httpPair !== null);
if (httpPair) {
  eq("桥请求的第一个键是名单里的 http", capsMod[httpPair[1]], capsMod.HTTP);
  eq("桥请求的第二个键前缀是共享的 httpHostPrefix", capsMod[httpPair[2]], capsMod.HTTP_HOST_PREFIX);
}

// 行为面：真的走一遍桥的 http.request，看它按什么键申请、且不补默认端口。
// 授权桩按名单放行（http:<host> 是授权表键、不在名单里，按前缀放行）
const grantAll = (args) =>
  capsFile.capabilities.includes(args.capability) || args.capability.startsWith(capsFile.httpHostPrefix);
{
  resetStub();
  invalidatePermissions();
  setReply("permission_check", grantAll);
  setReply("http_request", { status: 200, contentType: null, body: "", truncated: false });
  const ctx = buildContext({ id: "uz.http.https", name: "H", permissions: [capsMod.HTTP] });
  try {
    await ctx.http.request("https://api.example.com/path");
    check("https 请求走通（桩放行）", true);
  } catch (err) {
    check("https 请求走通（桩放行）", false, String(err));
  }
  deep(
    "https 无显式端口：申请的键不带 :443（默认端口陷阱的行为面）",
    tauriCalls.filter((c) => c.cmd === "permission_check").map((c) => c.args.capability),
    [capsMod.HTTP, `${capsMod.HTTP_HOST_PREFIX}api.example.com`],
  );
  check("放行后确实发出 http_request", tauriCalls.some((c) => c.cmd === "http_request"));

  resetStub();
  invalidatePermissions();
  setReply("permission_check", grantAll);
  setReply("http_request", { status: 200, contentType: null, body: "", truncated: false });
  const ctx80 = buildContext({ id: "uz.http.port80", name: "H", permissions: [capsMod.HTTP] });
  try {
    await ctx80.http.request("http://plain.example:80/x");
    check("显式 :80 的请求走通（桩放行）", true);
  } catch (err) {
    check("显式 :80 的请求走通（桩放行）", false, String(err));
  }
  deep(
    "显式 :80 等于默认端口：键同样不带端口",
    tauriCalls.filter((c) => c.cmd === "permission_check").map((c) => c.args.capability),
    [capsMod.HTTP, `${capsMod.HTTP_HOST_PREFIX}plain.example`],
  );

  resetStub();
  invalidatePermissions();
  const denied = buildContext({ id: "uz.http.denied", name: "H", permissions: [capsMod.HTTP] });
  await (async () => {
    try {
      await denied.http.request("https://deny.example/x");
      check("域名被拒时应当抛错", false, "居然没抛");
    } catch (err) {
      check("域名被拒时抛错且带 host", String(err).includes("域名授权被拒绝: deny.example"));
    }
  })();
}

/* ==================== widget 代发：`<id>:widget` 的跨侧对撞 ==================== */
group("widget 能力代发 `<id>:widget`");

// Rust 侧形状：bus:publish 或（topic 恰为 {id}:widget 且 widget 在授权表里）
const busWidget = flat(rustSrc("commands/bus.rs")).match(
  /let allowed = is_granted\(id, crate::plugin_caps::([A-Z_]+)\) \|\| \(topic == format!\("\{id\}:([a-z]+)"\) && is_granted\(id, crate::plugin_caps::([A-Z_]+)\)\)/,
);
check("bus.rs 代发形状可得（防提取口径失效）", busWidget !== null);
if (busWidget) {
  eq("代发主闸是 bus:publish", rustConsts.get(busWidget[1]), "bus:publish");
  eq("代发条件认 widget 能力", rustConsts.get(busWidget[3]), "widget");
  // 反例（冒充）：代发的 topic 后缀必须就是 widget 的名字 —— 换成 {id}:cmd 之类即红
  eq("代发的 topic 后缀与 widget 名字逐字一致（冒充反例）", busWidget[2], capsMod.WIDGET);
}

// TS 侧形状：桥的 widget.update 门禁在共享常量上，发布 topic 是 `${pid}:<widget>`
const widgetPublish = bridgeSrc.match(/bus\.publish\(`\$\{pid\}:([a-z]+)`, data, pid\)/);
check("桥的 widget 发布点形状可得（防提取口径失效）", widgetPublish !== null);
if (widgetPublish) {
  eq("桥发布 topic 的后缀与 widget 名字逐字一致（冒充反例）", widgetPublish[1], capsMod.WIDGET);
}

// 行为面：拿 widget 能力真的能 update，且向外发的是 <id>:widget
{
  resetStub();
  invalidatePermissions();
  setReply("permission_check", (args) => capsFile.capabilities.includes(args.capability));
  const ctx = buildContext({ id: "uz.widget", name: "W", permissions: [capsMod.WIDGET] });
  await ctx.widget.update({ n: 1 });
  check(
    "widget.update 以 <id>:widget 发布",
    tauriCalls.some((c) => c.cmd === "bus_publish" && c.args.topic === `uz.widget:${capsMod.WIDGET}` && c.args.pluginId === "uz.widget"),
  );
  check(
    "widget.update 的门禁就查共享名单里的 widget",
    tauriCalls.some((c) => c.cmd === "permission_check" && c.args.capability === capsMod.WIDGET),
  );
}

/* ==================== :widget 回灌：两处 endsWith 一致 ==================== */
group("`:widget` 回灌判定两处一致");

const widgetSuffixRust = flat(rustSrc("commands/bus.rs")).match(
  /fn is_widget_topic\(topic: &str\) -> bool \{ topic\.ends_with\(":([a-z]+)"\) \}/,
);
const eventBusSrc = flat(readFileSync(new URL("../../src/runtime/event-bus.ts", import.meta.url), "utf8"));
const widgetSuffixTs = eventBusSrc.match(/topic\.endsWith\(":([a-z]+)"\)/);
check("bus.rs 的回灌判定形状可得", widgetSuffixRust !== null);
check("event-bus.ts 的回灌判定形状可得", widgetSuffixTs !== null);
if (widgetSuffixRust && widgetSuffixTs) {
  eq("Rust 侧回灌后缀就是 widget 名字", widgetSuffixRust[1], capsMod.WIDGET);
  eq("TS 侧回灌后缀就是 widget 名字", widgetSuffixTs[1], capsMod.WIDGET);
  eq("两侧后缀逐字一致", widgetSuffixTs[1], widgetSuffixRust[1]);
}

// 行为面：订阅 `*:widget` 时向宿主要最近一份；别的 topic 不要
{
  resetStub();
  let replayed = null;
  bus.subscribe("uz.replay:widget", () => {});
  eq("订阅 :widget 触发一次 bus_peek", tauriCalls.filter((c) => c.cmd === "bus_peek").length, 1);
  bus.subscribe("uz.replay:cmd", () => {});
  eq("订阅非 :widget 不触发回灌", tauriCalls.filter((c) => c.cmd === "bus_peek").length, 1);
  setReply("bus_peek", { v: 7 });
  // 再订一份带记录的 handler（stub 的 invoke 这时已有回包，回灌要走完整链）
  bus.subscribe("uz.replay:widget", (value) => {
    replayed = value;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("回灌数据真的派发给了订阅者", replayed !== null && replayed.v === 7, `实际 ${JSON.stringify(replayed)}`);
}

/* ==================== agent:hooks 门禁（设置页专属，行为面） ==================== */
group("agent:hooks 门禁");

{
  resetStub();
  invalidatePermissions();
  const hooks = createAgentHooksApi({ id: "uz.hooks", name: "H", permissions: [] });
  try {
    await hooks.status();
    check("未授权时 agentHooks.status 被拒", false, "居然放行");
  } catch (err) {
    check("被拒且名字是共享名单里的 agent:hooks", String(err).includes(`权限被拒绝: ${capsMod.AGENT_HOOKS}`), String(err));
  }
  resetStub();
  invalidatePermissions();
  setReply("permission_check", grantAll);
  setReply("agent_hooks_status", { managed: 0 });
  const hooksOk = createAgentHooksApi({ id: "uz.hooks2", name: "H", permissions: [capsMod.AGENT_HOOKS] });
  await hooksOk.status();
  check(
    "授权后 status 走通且门禁查的就是 agent:hooks",
    tauriCalls.some((c) => c.cmd === "permission_check" && c.args.capability === capsMod.AGENT_HOOKS) &&
      tauriCalls.some((c) => c.cmd === "agent_hooks_status"),
  );
}

/* ==================== topic 前缀归属：三份判定正反用例 ==================== */
group("topic 前缀归属");

{
  const noThrow = (label, fn) => {
    try {
      fn();
      check(label, true);
    } catch (err) {
      check(label, false, `意外抛错: ${err.message}`);
    }
  };
  noThrow("自己前缀的发布放行", () => acl.assertPublishable("com.pet.todo", "com.pet.todo:changed"));
  throws("带通配的发布一律拒", () => acl.assertPublishable("com.pet.todo", "com.pet.todo:*"), "只能发布");
  noThrow("订自己前缀不需要任何授权", () => acl.assertSubscribable("com.pet.todo", "com.pet.todo:widget", []));
  noThrow("自己前缀内的通配可以订", () => acl.assertSubscribable("com.pet.todo", "com.pet.todo:*", []));
  throws("订他人 topic 没声明 bus:subscribe 拒", () => acl.assertSubscribable("com.pet.todo", "agent:state", []), "需要在 manifest 声明 bus:subscribe");
  noThrow("声明 bus:subscribe 后能订宿主 topic", () => acl.assertSubscribable("com.pet.todo", "agent:state", [capsMod.BUS_SUBSCRIBE]));
  throws("通配越过自己前缀一律拒（即便声明了 bus:subscribe）", () => acl.assertSubscribable("com.pet.todo", "com.pet.astock:*", [capsMod.BUS_SUBSCRIBE]), "越过了自己的命名空间");
  throws("裸通配「*」同样拒", () => acl.assertSubscribable("com.pet.todo", "*", [capsMod.BUS_SUBSCRIBE]), "越过了自己的命名空间");
  // ADR-0011：跨命名空间只认公开 topic —— 「声明了 bus:subscribe」不再等于「能读任意命名空间」
  throws("订他人插件的私有 topic：声明了 bus:subscribe 也拒", () => acl.assertSubscribable("com.pet.todo", "com.pet.astock:widget", [capsMod.BUS_SUBSCRIBE]), "被拒");
  throws("订他人插件的指令通道：同样拒", () => acl.assertSubscribable("com.pet.todo", "com.pet.astock:cmd", [capsMod.BUS_SUBSCRIBE]), "被拒");
  noThrow("公开名单里的宿主 BLE 事件：声明后可订", () => acl.assertSubscribable("com.pet.todo", "ble:device-found", [capsMod.BUS_SUBSCRIBE]));
  noThrow("登记为公开的他人前缀 topic：声明后可订", () => acl.assertSubscribable("com.pet.hr-ble", "com.pet.todo:changed", [capsMod.BUS_SUBSCRIBE]));
  throws("公开名单外的宿主 topic 也不放行（名单是白名单不是黑名单）", () => acl.assertSubscribable("com.pet.todo", "host:fullscreen", [capsMod.BUS_SUBSCRIBE]), "被拒");

  // widget 侧的窄化总线：publish 还要再验 bus:publish 授权（第三处判定，K3 一起收）
  const fakeBus = { published: [], publish(topic, payload, pluginId) { this.published.push({ topic, payload, pluginId }); }, subscribe() { return () => {}; } };
  const scoped = acl.createScopedBus("com.pet.todo", [capsMod.BUS_SUBSCRIBE], fakeBus);
  throws("scoped bus 没声明 bus:publish 发布拒", () => scoped.publish("com.pet.todo:changed", 1), "需要在 manifest 声明 bus:publish");
  eq("拒的时候没有真的发出去", fakeBus.published.length, 0);
  const scopedOk = acl.createScopedBus("com.pet.todo", [capsMod.BUS_PUBLISH, capsMod.BUS_SUBSCRIBE], fakeBus);
  scopedOk.publish("com.pet.todo:changed", 2);
  eq("声明后发出且带 pluginId", fakeBus.published.length, 1);
  eq("发的 topic", fakeBus.published[0].topic, "com.pet.todo:changed");
  eq("带的 pluginId", fakeBus.published[0].pluginId, "com.pet.todo");
}

// 行为面（桥的 subscribe API）：没声明 bus:subscribe 时连 API 本身都被拒
{
  resetStub();
  invalidatePermissions();
  const ctx = buildContext({ id: "uz.sub", name: "S", permissions: [] });
  try {
    await ctx.bus.subscribe("agent:state", () => {});
    check("未声明 bus:subscribe 的订阅应当被拒", false, "居然放行了");
  } catch (err) {
    check("未声明时 API 本身被拒（桥回拒：权限被拒绝）", String(err).includes(`权限被拒绝: ${capsMod.BUS_SUBSCRIBE}`), String(err));
  }
  // 模拟 Rust 侧 permission_request 对未声明能力的拒绝（真实文案见 services/permission.rs）
  resetStub();
  invalidatePermissions();
  setReply("permission_request", () => {
    throw new Error(`uz.sub2 未在 manifest 声明这些能力: ${capsMod.BUS_SUBSCRIBE}`);
  });
  const ctx2 = buildContext({ id: "uz.sub2", name: "S", permissions: [] });
  try {
    await ctx2.bus.subscribe("agent:state", () => {});
    check("Rust 侧未声明拒绝应当透传到插件", false, "居然放行了");
  } catch (err) {
    check("Rust 侧「未在 manifest 声明」原样透传", String(err).includes("未在 manifest 声明这些能力"), String(err));
  }
}

/* ==================== 反向钉住：两侧源码与插件 manifest ==================== */
group("反向钉住·TS 门禁点");

// 桥里 20 个 gated 调用点：第二参要么是共享常量（解析回名单），要么是名单里的字面量；
// 裸字符串一律不许（卡片 §8：gated(manifest, "…" 不再出现）
{
  const slots = [...bridgeSrc.matchAll(/gated\(manifest, ([A-Za-z_0-9]+|"[^"]*"),/g)].map((m) => m[1]);
  check("桥的 gated 调用点数量不少于 20（防提取口径失效）", slots.length >= 20, `实际 ${slots.length}`);
  for (const slot of slots) {
    if (slot.startsWith('"')) {
      check(`gated 第一参不许裸字面量：${slot}`, capsFile.capabilities.includes(slot.slice(1, -1)), slot);
    } else {
      check(`gated 第一参 ${slot} 解析回名单里的名字`, capsFile.capabilities.includes(capsMod[slot]), `capsMod.${slot} = ${String(capsMod[slot])}`);
    }
  }
  const includes = [...flat(readFileSync(new URL("../../src/runtime/topic-acl.ts", import.meta.url), "utf8")).matchAll(/permissions\.includes\(([A-Za-z_0-9]+|"[^"]*")\)/g)].map((m) => m[1]);
  check("topic-acl.ts 的 includes 判定不少于 2 处（防提取口径失效）", includes.length >= 2, `实际 ${includes.length}`);
  for (const slot of includes) {
    if (slot.startsWith('"')) {
      check(`includes 参数不许裸字面量：${slot}`, capsFile.capabilities.includes(slot.slice(1, -1)), slot);
    } else {
      check(`includes 参数 ${slot} 解析回名单里的名字`, capsFile.capabilities.includes(capsMod[slot]), `capsMod.${slot} = ${String(capsMod[slot])}`);
    }
  }
}

group("反向钉住·Rust 门禁点");

// 八个门禁文件里每一处 crate::plugin_caps:: 引用都要能解析（const 命中 const 表，函数命中白名单），
// 且 const 的取值都在名单里（前面已断）。引用计数下限防提取口径失效。
{
  const RUST_FILES = [
    "services/notify.rs",
    "services/ble.rs",
    "commands/bus.rs",
    "services/http.rs",
    "services/permission.rs",
    "services/store.rs",
    "commands/agent.rs",
    "window/overlay.rs",
  ];
  let refCount = 0;
  for (const rel of RUST_FILES) {
    for (const m of flat(rustSrc(rel)).matchAll(/crate::plugin_caps::([A-Za-z_0-9]+)/g)) {
      refCount += 1;
      const ref = m[1];
      if (rustConsts.has(ref)) continue;
      if (RUST_FNS.has(ref)) continue;
      check(`引用 ${rel} 的 crate::plugin_caps::${ref} 能解析`, false, "既不是 const 表里的名字，也不是已知函数");
    }
  }
  check("八个文件的 plugin_caps 引用不少于 15 处（防提取口径失效）", refCount >= 15, `实际 ${refCount}`);
  // 九条 const 每条至少被一个门禁点引用（防「改了名单但引用没跟上」的反面：const 表飘出去）
  const referenced = new Set(
    RUST_FILES.flatMap((rel) => [...flat(rustSrc(rel)).matchAll(/crate::plugin_caps::([A-Z_0-9]+)/g)].map((m) => m[1])),
  );
  for (const name of rustConsts.keys()) {
    check(`rust const ${name} 至少被一处门禁引用`, referenced.has(name), "没有引用点");
  }
}

group("反向钉住·四个插件 manifest");

{
  const dir = new URL("../../plugins/", import.meta.url);
  const manifests = readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).replaceAll("\\", "/"))
    .filter((rel) => rel.endsWith("manifest.json"));
  eq("四个在售插件各一份 manifest", manifests.length, 4);
  const union = new Set();
  for (const rel of manifests) {
    const parsed = JSON.parse(readFileSync(new URL(rel, dir), "utf8"));
    for (const perm of parsed.permissions ?? []) {
      union.add(perm);
      check(`${rel} 声明的 ${perm} 在名单里`, capsFile.capabilities.includes(perm), "不在名单 —— 要么改名，要么先登记名单");
    }
  }
  eq("四份 manifest 的 permissions 并集恰好覆盖 12 名（无漏网）", sorted(union).length, 12);
}

/* ============ 风险面元数据：riskFlags 是名单的子集，TS 与 JSON 逐字相等 ============ */
// S2：宿主设置页的「风险权限标险」口径不能再是 plugin-page.ts 里的硬编码字面量，
// 必须回到名单本体的 riskFlags 上。判据（PM 定死，不许扩也不许缩）就是这三个名字。
group("风险面元数据 riskFlags");

/** 卡片 §3 定死的三名（顺序照此写，与 PLUGIN_SDK.md §3 表格的「风险面」列一致） */
const EXPECTED_RISK = ["http", "storage", "agent:hooks"];

check("plugin-capabilities.json 有 riskFlags 数组", Array.isArray(capsFile.riskFlags), `实际 ${JSON.stringify(capsFile.riskFlags)}`);
eq("riskFlags 恰好 3 个名字", Array.isArray(capsFile.riskFlags) ? capsFile.riskFlags.length : -1, 3);
eq("riskFlags 无重复项", new Set(capsFile.riskFlags ?? []).size, 3);
// 顺序敏感：写成 ["storage","http",…] 或改词都红（逐字 + 逐序）
deep("riskFlags 顺序与内容逐字等于既定三名", [...(capsFile.riskFlags ?? [])], EXPECTED_RISK);
check(
  "riskFlags 每个名字都在 capabilities 里（子集）",
  (capsFile.riskFlags ?? []).every((n) => capsFile.capabilities.includes(n)),
  `riskFlags=${JSON.stringify(capsFile.riskFlags)}`,
);
// 三个名字逐条落到真实能力上（防拼成 hooks / agent_hooks 这类错拼）
for (const r of EXPECTED_RISK) {
  check(`风险名 "${r}" 是名单里的能力（不是错拼）`, capsFile.capabilities.includes(r), "不在 capsFile.capabilities 里");
}

// TS 侧：RISK_FLAGS 冻结，且与 JSON 的 riskFlags 逐字逐序相等（改任一边都红）
check("TS 模块导出 RISK_FLAGS 数组", Array.isArray(capsMod.RISK_FLAGS), `实际 ${JSON.stringify(capsMod.RISK_FLAGS)}`);
deep("RISK_FLAGS 与 JSON 的 riskFlags 逐字逐序相等", [...(capsMod.RISK_FLAGS ?? [])], [...(capsFile.riskFlags ?? [])]);
check("RISK_FLAGS 已冻结", capsMod.RISK_FLAGS !== undefined && Object.isFrozen(capsMod.RISK_FLAGS));
deep("RISK_FLAGS 集合等于既定三名", sorted(capsMod.RISK_FLAGS ?? []), sorted(EXPECTED_RISK));

// 消费点：设置页的标险必须回到共享常量，不能再有裸字面量判断
const pluginPageSrc = readFileSync(new URL("../../src/settings/plugin-page.ts", import.meta.url), "utf8");
check('plugin-page.ts 不再出现 `p === "http"` 硬编码', !pluginPageSrc.includes('p === "http"'), "还留着字面量判定");
check("plugin-page.ts 消费共享的 RISK_FLAGS", pluginPageSrc.includes("RISK_FLAGS"), "没 import/使用 RISK_FLAGS");
