// 验证用临时插件 fixture：由脚本写入 plugins/、跑完删除（.gitignore 已忽略这两个名字，
// 中途崩溃也不会被误提交）。前缀 zz. 便于人工识别残留。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROBE_ID = "zz.probe";
export const SPOOF_DIR = "com.zz.spoof"; // 目录名与 manifest.id 不一致 → 必须被宿主剔除
export const SPOOF_CLAIMED_ID = "com.pet.hr-ble";

const PROBE_MANIFEST = {
  id: PROBE_ID,
  name: "隔离探针",
  version: "0.0.0",
  entry: "index.js",
  widget: "widget.js",
  permissions: [],
  description: "验证用探针：以零权限第三方身份尝试越权，结果写进 window.__probes。",
};

const SPOOF_MANIFEST = {
  id: SPOOF_CLAIMED_ID,
  name: "冒名插件",
  version: "0.0.0",
  entry: "index.js",
  permissions: ["ble:connect"],
};

// 探针 widget：mount 时逐项尝试，并把结果 append 到 window.__probes。
// 注意其中 eval / <style> 注入两项是「页面自身代码」的行为，因此才可用于判断 CSP 是否强制；
// 由 CDP 直接求值的同名调用不受 CSP 约束，不能当判据。
const PROBE_WIDGET = `export function mount(root, ctx) {
  const r = { region: ctx.region, attempts: {} };
  const attempt = (label, fn) => {
    try { fn(); r.attempts[label] = "THROUGH"; } catch { r.attempts[label] = "BLOCKED"; }
  };
  r.busKeys = Object.keys(ctx.bus).sort();
  r.hasInject = typeof ctx.bus.inject === "function";
  r.hasHandlers = "handlers" in ctx.bus;

  attempt("publish_own", () => ctx.bus.publish("${PROBE_ID}:self", {}));
  attempt("publish_foreign", () => ctx.bus.publish("com.pet.hr-ble:bpm", { bpm: 1 }));
  attempt("publish_host", () => ctx.bus.publish("ble:heart-rate", { bpm: 666 }));
  attempt("publish_wildcard", () => ctx.bus.publish("${PROBE_ID}:*", {}));
  attempt("subscribe_own", () => ctx.bus.subscribe("${PROBE_ID}:own", () => {}));
  attempt("subscribe_own_wildcard", () => ctx.bus.subscribe("${PROBE_ID}:*", () => {}));
  attempt("subscribe_host", () => ctx.bus.subscribe("ble:heart-rate", () => {}));
  attempt("subscribe_all_wildcard", () => ctx.bus.subscribe("*", () => {}));
  attempt("subscribe_foreign_wildcard", () => ctx.bus.subscribe("com.pet.hr-ble:*", () => {}));

  try {
    (0, eval)("1");
    r.csp = "unforced";
  } catch (err) {
    r.csp = /unsafe-eval/.test(String(err)) ? "enforced" : "eval-error";
  }

  const style = document.createElement("style");
  style.textContent = ".zzp{color: rgb(1, 2, 3);}";
  const node = document.createElement("div");
  node.className = "zzp";
  root.append(style, node);
  r.styleApplied = getComputedStyle(node).color === "rgb(1, 2, 3)";

  (window.__probes = window.__probes || []).push(r);
}

export function unmount() {}
`;

const PROBE_INDEX = `export function activate(ctx) {
  window.__probeCtxKeys = Object.keys(ctx).sort();
  window.__probeActivated = (window.__probeActivated || 0) + 1;
}
export function deactivate() {
  window.__probeDeactivated = (window.__probeDeactivated || 0) + 1;
}
`;

function writePlugin(pluginsDir, dirName, manifest, files) {
  const dir = join(pluginsDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

export function writeFixtures(pluginsDir) {
  writePlugin(pluginsDir, PROBE_ID, PROBE_MANIFEST, { "index.js": PROBE_INDEX, "widget.js": PROBE_WIDGET });
  // 冒名目录只放 manifest 与空入口：它应当在 plugins_list 阶段就被剔除，根本轮不到加载
  writePlugin(pluginsDir, SPOOF_DIR, SPOOF_MANIFEST, { "index.js": "export function activate() {}\n" });
}

export function removeFixtures(pluginsDir) {
  for (const name of [PROBE_ID, SPOOF_DIR]) rmSync(join(pluginsDir, name), { recursive: true, force: true });
}
