// 跨窗口事件总线：publish 同窗口即时派发 + 经 Rust 中继广播到全部窗口
// （接收端按 origin 去重）。topic 支持前缀通配，如 "com.pet.hr-ble:*"。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Handler = (payload: unknown) => void;

class EventBus {
  /** 嵌套派发上限：正常链路（事件→插件→再广播）远用不到，越界即自递归 */
  private static readonly MAX_DEPTH = 8;
  private depth = 0;
  private handlers = new Map<string, Set<Handler>>();
  private label = getCurrentWindow().label;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await listen<{ origin: string; topic: string; payload: unknown }>("bus", (e) => {
      const { origin, topic, payload } = e.payload;
      if (origin === this.label) return;
      this.dispatch(topic, payload);
    });
  }

  publish(topic: string, payload: unknown): void {
    this.dispatch(topic, payload);
    // 中继失败只影响其他窗口，不能让它变成宿主未处理的 rejection
    invoke("bus_publish", { topic, payload }).catch((err) => {
      console.error(`[bus] relay failed: ${topic}`, err);
    });
  }

  /** 宿主注入 Rust 原生事件到总线（不回传 Rust，避免回环） */
  inject(topic: string, payload: unknown): void {
    this.dispatch(topic, payload);
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private dispatch(topic: string, payload: unknown): void {
    // 通配订阅者在 handler 里再 publish 会自递归；不加深度的话栈溢出异常会被
    // 下面 per-handler 的 try 吞掉，表现成无限刷 console 而不是明确报错
    if (this.depth >= EventBus.MAX_DEPTH) {
      console.error(`[bus] 派发递归超过 ${EventBus.MAX_DEPTH} 层，已中止: ${topic}`);
      return;
    }
    this.depth += 1;
    try {
      for (const [pattern, set] of this.handlers) {
        const matched =
          pattern === topic || (pattern.endsWith("*") && topic.startsWith(pattern.slice(0, -1)));
        if (!matched) continue;
        // 复制一份：handler 在派发期间退订/订阅不会影响本轮
        for (const handler of [...set]) {
          try {
            handler(payload);
          } catch (err) {
            console.error(`[bus] handler error on ${topic}`, err);
          }
        }
      }
    } finally {
      this.depth -= 1;
    }
  }
}

export const bus = new EventBus();
