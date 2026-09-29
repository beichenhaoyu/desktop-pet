// 游戏模式：检测到别的应用铺满整块显示器时，宠物隐身并安静下来。
//
// 分工：判定在 Rust（services/fullscreen.rs，只负责报「有没有全屏」），
// 这里只决定「要不要因此藏起来」。开关关着时连传感都不启动，
// 所以不玩这个功能的人不会多一份轮询开销。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const KEY = "host:game-mode";

/** 默认开启：装了桌面宠物又常全屏的人，多半正是想要这个行为 */
export function gameModeEnabled(): boolean {
  return localStorage.getItem(KEY) !== "0";
}

export function setGameModeEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? "1" : "0");
}

/**
 * control.pause / control.resume 必须由调用方显式驱动：
 * 窗口被 hide 之后，WebView2 并不会把页面标记成 document.hidden，
 * 只靠 visibilitychange 的话动画与轮询会照常跑 —— 「隐身但没省下来」是这个功能最容易自欺的地方。
 */
export async function installGameMode(control: {
  pause: () => void;
  resume: () => void;
}): Promise<void> {
  const win = getCurrentWindow();
  let hiddenByMode = false;

  await invoke("fullscreen_watch_set", { enabled: gameModeEnabled() });

  async function apply(active: boolean): Promise<void> {
    if (active && !hiddenByMode) {
      hiddenByMode = true;
      control.pause();
      await win.hide();
    } else if (!active && hiddenByMode) {
      hiddenByMode = false;
      await win.show();
      control.resume();
    }
  }

  await listen<{ active: boolean }>("host:fullscreen", async (e) => {
    if (!gameModeEnabled()) return;
    try {
      await apply(e.payload.active === true);
    } catch (err) {
      // 不能静默：capability 少一条（比如没给 core:window:allow-hide）时，
      // 静默 catch 会让整个功能「看起来没反应」，排查只能从头再来
      hiddenByMode = false;
      console.error("[game-mode] 切换显示失败", err);
    }
  });

  // 设置窗切换开关 → 同步传感与显示状态
  await listen<{ enabled: boolean }>("host:game-mode-changed", async (e) => {
    await invoke("fullscreen_watch_set", { enabled: e.payload.enabled });
    if (!e.payload.enabled) await apply(false);
  });
}
