// L1 原型取证插件（ADR-0006）：把自己所在 realm 的事实写进自己的隔离存储，
// 外部只用 CDP 读这份副作用 —— 本仓判「隔离是否真的成立」的唯一合法姿势。
// 它不是产品插件，由 tests/e2e/verify-worker.mjs 装进 plugins 目录、跑完删掉。
import { LEAF_MARKER } from "./leaf.js";

const ID = "zz.l1-probe";
let ctx = null;

/**
 * 绕过 ctx 代理，直接照协议形状往宿主发一条裸消息。
 * 同 realm 时代这就是「插件自己 import invoke」的等价物，Worker 里它只剩这一条通道可走。
 */
function rawCall(method, args) {
  return new Promise((resolve) => {
    const seq = 900000 + Math.floor(Math.random() * 90000);
    const prev = globalThis.onmessage;
    globalThis.onmessage = (event) => {
      const data = event && event.data;
      if (data && data.t === "result" && data.seq === seq) {
        globalThis.onmessage = prev;
        resolve(data.ok ? { ok: true, value: data.value } : { ok: false, code: data.error.code, message: data.error.message });
        return;
      }
      if (prev) prev(event);
    };
    globalThis.postMessage({ t: "call", seq, method, args });
  });
}

async function probe() {
  const facts = {
    leaf: LEAF_MARKER,
    entryUrl: import.meta.url,
    hasWindow: typeof window !== "undefined",
    hasDocument: typeof document !== "undefined",
    hasLocalStorage: typeof localStorage !== "undefined",
    hasInternals: typeof globalThis.__TAURI_INTERNALS__ !== "undefined",
    ctxId: ctx ? ctx.pluginId : null,
  };
  try {
    await import("@tauri-apps/api/core");
    facts.bareImport = "resolved";
  } catch (err) {
    facts.bareImport = "rejected";
    facts.bareImportText = String(err && err.message ? err.message : err).slice(0, 80);
  }
  // Tauri 在 Windows 上的 IPC 走 http://ipc.localhost：能不能从 Worker 里裸调，量一次
  try {
    const res = await fetch("http://ipc.localhost/probe", { method: "POST", body: "{}" });
    facts.ipcFetch = `status:${res.status}`;
  } catch (err) {
    facts.ipcFetch = "rejected";
    facts.ipcFetchText = String(err && err.message ? err.message : err).slice(0, 80);
  }
  facts.forged = {
    // 22 个方法表之外的名字：宿主必须当场拒，不能当透传
    unknownMethod: await rawCall("zz.any_command", { pluginId: ID }),
    // 冒名撤销别的插件授权（同 realm 时代这条拦不住，见 ADR-0006 第 6 点）
    revokeOther: await rawCall("permission_revoke", ["com.pet.hr-ble"]),
    // 用别人的 id 发总线消息：topic 前缀归属在宿主侧判，这里应当被拒
    publishAsOther: await rawCall("bus.publish", ["com.pet.hr-ble:widget", { forged: true }]),
  };
  // 存储按 id 隔离：读 todo 用过的那个键，应当什么都读不到
  facts.crossPluginRead = (await ctx.storage.get("tasks")) ?? null;
  return facts;
}

export async function activate(context) {
  ctx = context;
  await ctx.storage.set("facts", await probe());
  // 每次收到指令重新取一遍事实：这样「覆盖子模块之后旧实例还在不在」不必重启就能观察到
  await ctx.bus.subscribe(`${ID}:cmd`, async (payload) => {
    await ctx.storage.set("last", { echo: payload, facts: { leaf: LEAF_MARKER, entryUrl: import.meta.url } });
  });
  await ctx.storage.set("booted", true);
}

export async function deactivate() {
  await ctx?.storage.set("deactivated", true);
}
