// L2 阶段二取证（ADR-0008）：同一个 widget 文件在两个 realm 里各跑一遍，
// 把 realm 事实经 `ctx.bus` 报给自己的入口，由入口写进隔离存储 —— 徽标里面是 closed shadow root，
// 页面读不到里面的文字，不能拿 DOM 当出口；而「widget 发的 publish 能不能被入口收到」
// 本来就是这条接缝要验的东西，正好一箭双雕。
// 它不是产品插件：由 tests/e2e/verify-worker.mjs 装进 plugins 目录、跑完删掉。

const ID = "zz.l1-probe";
const TOPIC = `${ID}:widget-facts`;

let ctx = null;
let layout = 0;
let forbidden = "pending";

function inWorker() {
  return typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
}

/**
 * 照协议形状发一条 widget 调用面**之外**的方法（storage 不在 widget 那五个名字里）。
 * 验的是宿主「逢 call 必回」：不回包这里只能等到 timeout，而那个 timeout 就是插件永远起不来的样子。
 */
function rawCall(method, args) {
  if (!inWorker()) {
    return Promise.resolve({ ok: false, code: "skipped", message: "宿主 realm 里协议消息没有接收方" });
  }
  return new Promise((resolve) => {
    const seq = 800000 + Math.floor(Math.random() * 90000);
    const prev = globalThis.onmessage;
    const finish = (value) => {
      clearTimeout(timer);
      globalThis.onmessage = prev;
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), 4_000);
    globalThis.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.t === "result" && msg.seq === seq) {
        finish(msg.ok ? { ok: true, value: msg.value } : { ok: false, code: msg.error.code });
      } else if (prev) prev.call(globalThis, e);
    };
    globalThis.postMessage({ t: "call", seq, method, args });
  });
}

function facts() {
  return {
    at: Date.now(),
    realm: inWorker() ? "worker" : "document",
    region: ctx?.region ?? "?",
    // document / window 在 Worker 里必须是 undefined；host 这个键在 badge 区必须压根不存在
    //（不是「存在但调用被拒」），dom / onLayout 只在 Worker 路线才有
    hasDocument: typeof document !== "undefined",
    hasWindow: typeof window !== "undefined",
    hasHostKey: !!ctx && "host" in ctx,
    hasDom: !!ctx?.dom,
    hasOnLayout: typeof ctx?.onLayout === "function",
    layout,
    forbidden,
  };
}

function report() {
  if (!ctx) return;
  try {
    ctx.bus.publish(TOPIC, facts());
  } catch (error) {
    console.log(`${ID} widget 自报失败`, String(error));
  }
}

export function mount(root, context) {
  ctx = context;
  const box = ctx.dom ? ctx.dom.createElement("div") : document.createElement("div");
  box.className = "probe-badge";
  const label = ctx.dom ? ctx.dom.createElement("span") : document.createElement("span");
  label.textContent = "L1W";
  box.append(label);
  root.append(box);

  if (ctx.onLayout) {
    ctx.onLayout(() => {
      layout += 1;
      report();
    });
  }
  report();
  if (inWorker()) {
    void rawCall("storage.get", ["k"]).then((res) => {
      forbidden = res.ok ? "answered:ok" : `answered:${res.code}`;
      report();
    });
  } else {
    forbidden = "skipped";
    report();
  }
  // 异步落地的两条事实各补报一次，套件不必猜时间
  setTimeout(report, 400);
  setTimeout(report, 1600);
  setTimeout(report, 3200);
}

export function deactivate() {
  // 停用之后没有再自报的意义，也把在途的定时器与回调链断干净
  ctx = null;
}
