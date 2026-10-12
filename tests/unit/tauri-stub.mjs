// @tauri-apps/api/* 的离线桩（Q3）：让运行时模块能在 node --test 里被 import。
// 只桩「与 webview 打交道」这一层，被测对象的逻辑一行都不替它改：
// invoke 记录调用并按 replies 回东西，事件按订阅表同步派发，测试自己 fire。
export const calls = [];
export const replies = new Map();
const globalHandlers = new Map();
const windowHandlers = new Map();

export function setReply(cmd, value) {
  replies.set(cmd, value);
}

export function resetStub() {
  calls.length = 0;
  replies.clear();
  globalHandlers.clear();
  windowHandlers.clear();
}

export async function invoke(cmd, args = {}) {
  calls.push({ cmd, args });
  if (replies.has(cmd)) {
    const value = replies.get(cmd);
    if (typeof value === "function") return value(args);
    return structuredClone(value);
  }
  return null;
}

export async function listen(event, handler) {
  const list = globalHandlers.get(event) ?? [];
  list.push(handler);
  globalHandlers.set(event, list);
  return () => {
    const i = globalHandlers.get(event).indexOf(handler);
    if (i >= 0) globalHandlers.get(event).splice(i, 1);
  };
}

export async function emit(event, payload) {
  for (const handler of [...(globalHandlers.get(event) ?? [])]) {
    handler({ event, payload });
  }
}

/** 测试用：某窗口收到了原生事件 */
export function fireWindow(label, event, payload) {
  for (const handler of [...(windowHandlers.get(`${label}|${event}`) ?? [])]) {
    handler({ event, payload });
  }
}

export function handlerCount(event) {
  return (globalHandlers.get(event) ?? []).length;
}

const windows = new Map();

class StubWindow {
  constructor(label) {
    this.label = label;
  }

  async listen(event, handler) {
    const key = `${this.label}|${event}`;
    const list = windowHandlers.get(key) ?? [];
    list.push(handler);
    windowHandlers.set(key, list);
    return () => {
      const i = windowHandlers.get(key).indexOf(handler);
      if (i >= 0) windowHandlers.get(key).splice(i, 1);
    };
  }

  async once(event, handler) {
    const off = await this.listen(event, (e) => {
      void off();
      handler(e);
    });
    return off;
  }

  async startDragging() {}
  async setIgnoreCursorEvents() {}
  async close() {}
  async show() {}
  async hide() {}
  async outerPosition() {
    return { x: 100, y: 200 };
  }
  async scaleFactor() {
    return 2;
  }
}

export function getCurrentWindow() {
  const label = process.env.PET_STUB_WINDOW_LABEL ?? "pet";
  if (!windows.has(label)) windows.set(label, new StubWindow(label));
  return windows.get(label);
}

export async function cursorPosition() {
  return { x: 0, y: 0 };
}
