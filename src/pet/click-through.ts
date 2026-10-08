// 点击穿透：指针不在立绘范围内时，让鼠标事件落到宠物下方的窗口。
//
// 难点是穿透一旦开启，本窗口收不到任何 DOM 事件，没法靠 mousemove 察觉「指针回来了」，
// 所以穿透态改为轮询系统光标位置判定。而轮询依赖「窗口原点」这份缓存 ——
// 窗口会动（拖拽是主要路径，程序化 setPosition 也算），原点一过期，
// 「指针其实在宠物身上」就会被判成「在实体外」，于是穿透常开且再也翻不回来：
// 表现就是「拖一次之后宠物再也点不到、也就拖不动了」。两条腿兜住：
//   1) 听宿主的 tauri://move，窗口一动就重读原点；
//   2) 兜底：只要处于穿透态就定期无条件重读，哪怕那个事件没来也能自愈。
import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface SpriteBox {
  left: number;
  top: number;
  size: number;
}

interface Options {
  spriteRect: () => SpriteBox;
  isDragging: () => boolean;
  pollMs?: number;
  /** 判定余量：立绘边缘留一点，鼠标擦过就恢复交互 */
  pad?: number;
  /** 测试接缝：默认走真实 Tauri API，回归脚本可注入假光标与记录器 */
  readCursor?: () => Promise<{ x: number; y: number }>;
  windowOrigin?: () => Promise<{ x: number; y: number; scale: number }>;
  setThrough?: (enabled: boolean) => Promise<void>;
}

/** 处于穿透态时每几轮无条件重读一次原点（250ms × 8 ≈ 2 秒） */
const SELF_HEAL_TICKS = 8;

export function installClickThrough(opts: Options): () => void {
  const win = getCurrentWindow();
  const pollMs = opts.pollMs ?? 250;
  const pad = opts.pad ?? 8;

  const readCursor = opts.readCursor ?? cursorPosition;
  /**
   * 默认取原点实现。scaleFactor 只在偶尔几轮里重读（换显示器/DPI 改动才会变），
   * 因为它每多一次就多一次在飞 IPC —— 页面重载时会把在飞的调用切成
   * 「Couldn't find callback id」告警，轮询里塞两条 IPC 等于自己制造噪音。
   */
  let cachedScale = 0;
  let scaleAge = 0;
  const defaultOrigin = async (): Promise<{ x: number; y: number; scale: number }> => {
    const pos = await win.outerPosition();
    if (cachedScale === 0 || ++scaleAge >= 16) {
      scaleAge = 0;
      cachedScale = await win.scaleFactor();
    }
    return { x: pos.x, y: pos.y, scale: cachedScale || 1 };
  };
  const readOrigin = opts.windowOrigin ?? defaultOrigin;
  const writeThrough =
    opts.setThrough ??
    (async (enabled: boolean) => {
      await invoke("set_click_through", { enabled });
    });

  let through = false;
  let origin = { x: 0, y: 0, scale: 1 };
  let busy = false;
  let ticks = 0;
  let disposed = false;
  // 重读要串行：Moved 事件与轮询同时在跑时，先发的请求可能后到，不能让它覆盖新值
  let refreshing: Promise<void> = Promise.resolve();

  const refreshOrigin = (): Promise<void> => {
    refreshing = refreshing.then(async () => {
      if (disposed) return;
      try {
        origin = await readOrigin();
      } catch (err) {
        console.error("[click-through] 取窗口位置失败", err);
      }
    });
    return refreshing;
  };

  async function apply(next: boolean): Promise<void> {
    if (next === through) return;
    try {
      await writeThrough(next);
      through = next;
    } catch (err) {
      console.error("[click-through] 切换失败", err);
    }
  }

  async function poll(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (opts.isDragging()) {
        // 正被系统拖着走：交互保持打开。位置更新交给 tauri://move，
        // 这里不再重复取原点 —— 拖拽期间 Move 事件本来就在密集刷新。
        await apply(false);
        return;
      }
      if (through && ++ticks >= SELF_HEAL_TICKS) {
        ticks = 0;
        await refreshOrigin();
      }
      const cursor = await readCursor();
      // 系统光标是物理像素，立绘几何是 CSS 像素
      const localX = (cursor.x - origin.x) / origin.scale;
      const localY = (cursor.y - origin.y) / origin.scale;
      const r = opts.spriteRect();
      const inside =
        localX >= r.left - pad &&
        localX <= r.left + r.size + pad &&
        localY >= r.top - pad &&
        localY <= r.top + r.size + pad;
      await apply(!inside);
    } catch (err) {
      console.error("[click-through] 轮询失败", err);
    } finally {
      busy = false;
    }
  }

  const unlistenMove = listen<{ x: number; y: number }>("tauri://move", (e) => {
    // 事件载荷里就是新的物理位置，直接用：回一趟 outerPosition 等于每次移动多打一次 IPC
    origin = { x: e.payload.x, y: e.payload.y, scale: origin.scale };
  })
    .then((un) => {
      if (disposed) un();
      return un;
    })
    .catch((err) => {
      console.error("[click-through] 监听窗口移动失败", err);
      return () => {};
    });

  void refreshOrigin();
  const timer = window.setInterval(() => void poll(), pollMs);
  const dispose = () => {
    disposed = true;
    window.clearInterval(timer);
    window.removeEventListener("pagehide", dispose);
    void unlistenMove.then((un) => un());
  };
  // 页面要被导航/重载掉的时候先把自己停掉：否则下一轮轮询会往正在拆毁的 IPC 通道里
  // 发请求，得到一句「failed to get cursor position」——看着像缺陷，其实是导航的副作用
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
