// K4：manifest.schema.json 一致性单测 + 拒绝行为用例。
//
// 唯一数据源：packages/sdk/manifest.schema.json —— TS 侧 validateManifest 与 Rust 侧
// validate_manifest_fields 各有一份手写检查读它的值（本文件逐条对撞，改任一边即红）。
// 五类断言（卡片 §6）：① 模式串/长度与前端实际判定同值；② 四个真实 manifest 全通过；
// ③ permissions 元素类型与成员资格；④ apiVersion / minHostVersion；
// ⑤ schema 引用的能力名单与 K3 的 JSON 是同一份（不抄副本）。
//
// 运行：npm run unit:manifest（也随 npm run unit 一起跑）
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, deep, eq, group } from "./harness.mjs";

const schemaUrl = new URL("../../packages/sdk/manifest.schema.json", import.meta.url);
const schemaText = readFileSync(schemaUrl, "utf8");
const schema = JSON.parse(schemaText);
const capsUrl = new URL("../../packages/sdk/plugin-capabilities.json", import.meta.url);
const capsFile = JSON.parse(readFileSync(capsUrl, "utf8"));
const capsMod = await import(new URL("../../src/runtime/plugin-capabilities.ts", import.meta.url));
const { validateManifest } = await import(new URL("../../src/runtime/plugin-runtime.ts", import.meta.url));
const hostVersion = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).version;

/** 卡片 §3 定死的 12 名（与 unit-capabilities.mjs / plugin_caps.rs 单测同源）；顺序无关 */
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

/** schema 里全部字符串值（递归；用于「没有能力名副本」的判定 —— 只查值，键名如 widget 是字段名） */
const collectStrings = (node, out = []) => {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, out);
  else if (node && typeof node === "object") for (const item of Object.values(node)) collectStrings(item, out);
  return out;
};

/* ==================== ① schema 引用的名单与 K3 是同一份 ==================== */
group("schema 引用的能力名单与 K3 是同一份");

{
  const ref = schema.properties.permissions.capabilitiesRef;
  check("引用键 capabilitiesRef 存在且是字符串", typeof ref === "string" && ref.length > 0, String(ref));
  const [refFile, refAnchor] = String(ref).split("#");
  const refUrl = new URL(refFile, schemaUrl);
  eq(
    "引用解析到的就是 K3 的那一份磁盘文件（realpath 级同一份）",
    realpathSync(fileURLToPath(refUrl)),
    realpathSync(fileURLToPath(capsUrl)),
  );
  eq("引用的锚点 = 名单数组", refAnchor, "capabilities");
  const referenced = JSON.parse(readFileSync(fileURLToPath(refUrl), "utf8"))[refAnchor];
  deep("被引用的名单 == 既定 12 名（改一个名字这条即红）", sorted(referenced), sorted(EXPECTED));
  deep("被引用名单 == K3 模块的 CAPABILITIES", sorted(referenced), sorted(capsMod.CAPABILITIES));
  eq("schema 里没有第二份名单数组", schema.capabilities, undefined);
  eq(
    "permissions.items 没有内联枚举（名单只能走引用）",
    schema.properties.permissions.items.enum,
    undefined,
  );
  const schemaStrings = collectStrings(schema);
  for (const name of capsFile.capabilities) {
    check(`schema 的字符串值里没有能力名副本: ${name}`, !schemaStrings.includes(name), "名单必须走 capabilitiesRef，不许抄写");
  }
}

/* ============== ①+② schema 值 = 既有前端契约，且真函数按它判定 ============== */
group("schema 值逐字等于既有前端契约");

{
  eq("id 模式逐字照抄既有前端正则", schema.properties.id.pattern, "^[a-z0-9][a-z0-9.-]{2,63}$");
  eq("id 长度下限 = 首字符 + 量词下界 2", schema.properties.id.minLength, 3);
  eq("id 长度上限 = 首字符 + 量词上界 63", schema.properties.id.maxLength, 64);
  eq("entry 模式逐字照抄既有前端正则", schema.properties.entry.pattern, "^[\\w.-]+\\.js$");
  eq("widget 模式与 entry 同形", schema.properties.widget.pattern, schema.properties.entry.pattern);
  deep("必填键 = id/name/version/entry", schema.required, ["id", "name", "version", "entry"]);
  eq("apiVersion 缺省视为 1", schema.properties.apiVersion.default, 1);
  deep("宿主认识的 apiVersion = [1, 2]（2 = widget 渲染契约，ADR-0008）", schema.properties.apiVersion.supported, [1, 2]);
  eq("properties 条目数", Object.keys(schema.properties).length, 9);
}

group("validateManifest 的判定 == schema 声明的值（行为面对撞）");

{
  const tpl = (over = {}) => ({ id: "com.pet.uz", name: "N", version: "0.0.1", entry: "index.js", ...over });
  const idRule = schema.properties.id;
  const idRe = new RegExp(idRule.pattern);
  const schemaIdOk = (id) =>
    typeof id === "string" &&
    id.length >= idRule.minLength &&
    id.length <= idRule.maxLength &&
    idRe.test(id);
  const label = (id) => (id.length > 12 ? `${JSON.stringify(id.slice(0, 8))}…(${id.length} 字符)` : JSON.stringify(id));
  for (const id of [
    "todo",
    "a1.2-3",
    "com.pet.hr-ble",
    "ab",
    "a".repeat(64),
    "a".repeat(65),
    "Todo",
    "a_b",
    "../etc",
    "a/b",
    "a b",
    "-a",
    ".a",
    "a:b",
  ]) {
    eq(`id ${label(id)}：真函数与 schema 判定一致`, validateManifest(tpl({ id })) === null, schemaIdOk(id));
  }
  eq("entry=index.js 通过", validateManifest(tpl()), null);
  check("entry 带子目录被拒且文案带原值", (validateManifest(tpl({ entry: "a/index.js" })) ?? "").includes("a/index.js"));
  eq("widget=widget.js 通过", validateManifest(tpl({ widget: "widget.js" })), null);
  check("widget 非 .js 被拒", (validateManifest(tpl({ widget: "widget.mjs" })) ?? "").includes("widget"));

  // 模式串在运行时侧只许引用 schema —— 出现字面量副本即红（防「两份正则漂移」）
  const runtimeSrc = readFileSync(new URL("../../src/runtime/plugin-runtime.ts", import.meta.url), "utf8");
  check("plugin-runtime.ts 没有 id 模式串副本", !runtimeSrc.includes("[a-z0-9][a-z0-9.-]"));
  check("plugin-runtime.ts 没有 *.js 模式串副本", !runtimeSrc.includes("[\\w.-]+\\.js$"));
  check("plugin-runtime.ts 确实 import 了 schema 文件", runtimeSrc.includes("manifest.schema.json"));
  check("plugin-runtime.ts 的宿主版本取自 tauri.conf.json", runtimeSrc.includes("tauri.conf.json"));
}

/* ==================== ② 四个真实 manifest 全部通过 ==================== */
group("四个真实 manifest 全部通过新校验");

{
  const pluginsDir = new URL("../../plugins/", import.meta.url);
  const manifestRels = readdirSync(pluginsDir, { recursive: true })
    .map((rel) => String(rel).replaceAll("\\", "/"))
    .filter((rel) => rel.endsWith("manifest.json"));
  check("扫到的真实 manifest 不少于 4 份（防扫描口径失效）", manifestRels.length >= 4, `实际 ${manifestRels.length}`);
  for (const rel of manifestRels) {
    const parsed = JSON.parse(readFileSync(new URL(rel, pluginsDir), "utf8"));
    eq(`${rel} 通过新校验（不改插件也兼容）`, validateManifest(parsed), null);
  }
}

/* ==================== ③ permissions 元素（本卡修的真缺口） ==================== */
group("permissions 元素的类型与成员资格");

{
  const tpl = (over = {}) => ({ id: "com.pet.uz", name: "N", version: "0.0.1", entry: "index.js", ...over });
  for (const bad of [42, null, true, {}, ["x"]]) {
    const err = validateManifest(tpl({ permissions: ["storage", bad] }));
    check(
      `非字符串元素 ${JSON.stringify(bad)} 被拒且文案无可读性问题`,
      err !== null && err.includes("permissions 元素"),
      String(err),
    );
  }
  const unknown = validateManifest(tpl({ permissions: ["no.such:cap"] }));
  check("不在名单里的能力名被拒且文案带上它", unknown !== null && unknown.includes("no.such:cap"), String(unknown));
  deep(
    "名单里的每个名字都被接受（名单的消费面）",
    capsFile.capabilities.map((name) => validateManifest(tpl({ permissions: [name] }))).filter((x) => x !== null),
    [],
  );
  check("permissions 不是数组仍被拒", (validateManifest(tpl({ permissions: "storage" })) ?? "").includes("permissions"));
}

/* ==================== 必填键（schema.required 的消费面） ==================== */
group("必填键（schema.required）");

{
  const tpl = (over = {}) => ({ id: "com.pet.uz", name: "N", version: "0.0.1", entry: "index.js", ...over });
  for (const key of schema.required) {
    const m = tpl();
    delete m[key];
    const err = validateManifest(m);
    check(`缺 ${key} 被拒且文案带键名`, err !== null && err.includes(key), String(err));
  }
  eq("空 name 被拒", (validateManifest({ ...tpl(), name: "" }) ?? "").includes("name"), true);
  eq("空 version 被拒", (validateManifest({ ...tpl(), version: "" }) ?? "").includes("version"), true);
  eq("整个 manifest 不是对象被拒", String(validateManifest(null)).includes("不是对象"), true);
}

/* ==================== ④ apiVersion / minHostVersion ==================== */
group("apiVersion / minHostVersion");

{
  const tpl = (over = {}) => ({ id: "com.pet.uz", name: "N", version: "0.0.1", entry: "index.js", ...over });
  eq("缺 apiVersion 视为 v1：通过", validateManifest(tpl()), null);
  eq("显式 apiVersion=1：通过", validateManifest(tpl({ apiVersion: 1 })), null);
  eq("显式 apiVersion=2（渲染契约）：通过", validateManifest(tpl({ apiVersion: 2 })), null);
  const tooNew = validateManifest(tpl({ apiVersion: 99 }));
  check(
    "宿主不认识的 apiVersion 被拒且提示可读",
    tooNew !== null && tooNew.includes("apiVersion") && tooNew.includes("99"),
    String(tooNew),
  );
  const nonInt = validateManifest(tpl({ apiVersion: 1.5 }));
  check("非整数 apiVersion 被拒", nonInt !== null && nonInt.includes("apiVersion"), String(nonInt));
  eq("缺 minHostVersion 不设限：通过", validateManifest(tpl()), null);
  eq("minHostVersion 等于宿主版本：通过", validateManifest(tpl({ minHostVersion: hostVersion })), null);
  eq("minHostVersion 低于宿主版本：通过", validateManifest(tpl({ minHostVersion: "0.0.1" })), null);
  const parts = hostVersion.split(".").map(Number);
  parts[parts.length - 1] += 1;
  const nextPatch = parts.join(".");
  const tooOld = validateManifest(tpl({ minHostVersion: nextPatch }));
  check(
    "minHostVersion 高于宿主版本被拒且提示可读",
    tooOld !== null && tooOld.includes(nextPatch) && tooOld.includes(hostVersion),
    String(tooOld),
  );
  const junk = validateManifest(tpl({ minHostVersion: "v0.2" }));
  check("非法 minHostVersion 被拒", junk !== null && junk.includes("minHostVersion"), String(junk));
}

group("宿主版本两侧同源");

{
  const cargoToml = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
  const cargoVersion = /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/.exec(cargoToml)?.[1];
  check("能从 Cargo.toml 的 [package] 段取到版本", typeof cargoVersion === "string", String(cargoVersion));
  eq(
    "tauri.conf.json 与 Cargo.toml 的宿主版本一致（TS 与 Rust 的 minHostVersion 基准同源）",
    hostVersion,
    cargoVersion,
  );
}

/* ==================== Rust 侧接线（对同一份 schema） ==================== */
group("Rust 侧接线（同一份 schema / is_known 进生产）");

{
  const pluginsRs = readFileSync(new URL("../../src-tauri/src/commands/plugins.rs", import.meta.url), "utf8");
  const capsRs = readFileSync(new URL("../../src-tauri/src/plugin_caps.rs", import.meta.url), "utf8");
  check(
    "plugins.rs 内嵌的是同一份 schema 磁盘文件",
    pluginsRs.includes('include_str!("../../../packages/sdk/manifest.schema.json")'),
  );
  check("plugins.rs 有 schema 解析入口 manifest_schema()", /fn manifest_schema\(\)/.test(pluginsRs));
  check("collect_manifests 调用了 validate_manifest_fields", /validate_manifest_fields\(&v\)/.test(pluginsRs));
  check("declared_capabilities 不再静默丢弃非字符串元素", !pluginsRs.includes("filter_map(Value::as_str)"));
  check(
    "两个消费点都走 plugin_caps::is_known（生产调用 ≥ 2 处）",
    (pluginsRs.match(/plugin_caps::is_known\(name\)/g) ?? []).length >= 2,
  );
  check(
    "id 字符集仍走唯一实现 is_safe_id",
    pluginsRs.includes("use crate::ids::is_safe_id;") && pluginsRs.includes("is_safe_id(id)"),
  );
  check(
    "id 长度上下限读自 schema（minLength/maxLength）",
    pluginsRs.includes('get("minLength")') && pluginsRs.includes('get("maxLength")'),
  );
  check("plugin_caps.rs 的 all/is_known 已无 cfg(test) 包裹", !/#\[cfg\(test\)\]\s*pub fn (all|is_known)/.test(capsRs));
  check(
    "all/is_known 两个函数仍存在（防提取口径失效）",
    /pub fn all\(\)/.test(capsRs) && capsRs.includes("pub fn is_known("),
  );
}
