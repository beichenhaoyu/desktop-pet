// 点击穿透：指针不在立绘范围内时，让鼠标事件落到宠物下方的窗口。
//
// 难点是穿透一旦开启，本窗口收不到任何 DOM 事件，没法靠 mousemove 察觉「指针回来了」。
// 因此穿透态改为轮询系统光标位置判定；窗口位置在穿透期间不可能变
// （移动窗口只有拖拽一条路径，而拖拽时我们是关闭穿透的），所以缓存 outerPosition 是安全的。
import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
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

export function installClickThrough(opts: Options): () => void {
  const win = getCurrentWindow();
  const pollMs = opts.pollMs ?? 250;
  const pad = opts.pad ?? 8;

  const readCursor = opts.readCursor ?? cursorPosition;
  const readOrigin =
    opts.windowOrigin ??
    (async () => {
      const pos = await win.outerPosition();
      return { x: pos.x, y: pos.y, scale: await win.scaleFactor() };
    });
  const writeThrough =
    opts.setThrough ??
    (async (enabled: boolean) => {
      await invoke("set_click_through", { enabled });
    });

  let through = false;
  let origin = { x: 0, y: 0, scale: 1 };
  let busy = false;

  async function apply(next: boolean): Promise<void> {
    if (next === through) return;
    try {
      await writeThrough(next);
      through = next;
      // 恢复交互时刷新缓存：窗口可能刚被拖到新位置
      if (!next) origin = await readOrigin();
    } catch (err) {
      console.error("[click-through] 切换失败", err);
    }
  }

  async function poll(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (opts.isDragging()) {
        await apply(false);
        return;
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

  readOrigin()
    .then((o) => {
      origin = o;
    })
    .catch((err) => console.error("[click-through] 取窗口位置失败", err));
  const timer = window.setInterval(() => void poll(), pollMs);
  // 交给调用方一个停止句柄：测试里要能收掉自己装的那个轮询
  return () => window.clearInterval(timer);
}
