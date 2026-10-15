// L1 原型取证插件（ADR-0006）：把自己所在 realm 的事实写进自己的隔离存储，
// 外部只用 CDP 读这份副作用 —— 本仓判「隔离是否真的成立」的唯一合法姿势。
// 它不是产品插件，由 tests/e2e/verify-worker.mjs 装进 plugins 目录、跑完删掉。
import { LEAF_MARKER } from "./leaf.js";

const ID = "zz.l1-probe";
let ctx = null;

/**
 * 绕过 ctx 代理，直接照协议形状往宿主发一条裸消息。
 * 同 realm 时代这就是「插件自己 import invoke」的等价物，Worker 里它只剩这一条通道可走。
 *
 * 两个 realm 都得自己收尾（#47 量出来的坑）：
 *   - 宿主 realm 里 `postMessage` 是发给页面自己的，没有任何人会回 `result`；
 *   - Worker 里万一宿主没回（协议改了、会话断了），这个 await 也会永远挂着。
 * 而 activate 里的 await 一旦不 settle，插件的**串行启停链**就被永久占住，
 * 之后所有 deactivate 都排在死链上 —— 表现为「会话收不掉」「deactivated 写不出来」。
 * 所以：不在 Worker 就直接记 skipped，在 Worker 也带超时。
 */
const RAW_CALL_TIMEOUT_MS = 5_000;

function inWorker() {
  return typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
}

function rawCall(method, args) {
  if (!inWorker()) {
    return Promise.resolve({ ok: false, code: "skipped", message: "宿主 realm 里协议消息没有接收方" });
  }
  return new Promise((resolve) => {
    const seq = 900000 + Math.floor(Math.random() * 90000);
    const prev = globalThis.onmessage;
    const finish = (value) => {
      clearTimeout(timer);
      globalThis.onmessage = prev;
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: "timeout", message: `${method} 没有回包` });
    }, RAW_CALL_TIMEOUT_MS);
    globalThis.onmessage = (event) => {
      const data = event && event.data;
      if (data && data.t === "result" && data.seq === seq) {
        finish(data.ok ? { ok: true, value: data.value } : { ok: false, code: data.error.code, message: data.error.message });
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
  // Tauri 在 Windows 上的 IPC 走 http://ipc.localhost：能不能从 Worker 里裸调，量一次。
  // 只在 Worker 里试 —— 宿主 realm 里这条 fetch 会留下一句 500 的 console 噪声，
  // 而那正是 verify-* 的「零噪音」判据要数的东西，等于夹具自己把套件弄红。
  if (inWorker()) {
    try {
      const res = await fetch("http://ipc.localhost/probe", { method: "POST", body: "{}" });
      facts.ipcFetch = `status:${res.status}`;
    } catch (err) {
      facts.ipcFetch = "rejected";
      facts.ipcFetchText = String(err && err.message ? err.message : err).slice(0, 80);
    }
  } else {
    facts.ipcFetch = "skipped:not-a-worker";
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
