import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { $ } from "../dom";

/* ---------- 游戏模式 ---------- */

const GAME_MODE_KEY = "host:game-mode";

export function wireGameMode(): void {
  const box = $<HTMLInputElement>("game-mode-switch");
  if (!box) return;
  box.checked = localStorage.getItem(GAME_MODE_KEY) !== "0";
  box.addEventListener("change", async () => {
    const enabled = box.checked;
    localStorage.setItem(GAME_MODE_KEY, enabled ? "1" : "0");
    // 宠物窗据此启停传感并决定是否立刻恢复显示
    await emit("host:game-mode-changed", { enabled });
    void renderGameMode();
  });
}

export async function renderGameMode(): Promise<void> {
  const el2 = $<HTMLElement>("game-mode-status");
  if (!el2) return;
  try {
    const watching = await invoke<boolean>("fullscreen_watch_status");
    el2.textContent = watching
      ? "检测中：轮询一次前台窗口约 1.2 秒，代价可忽略。"
      : "已关闭：不再轮询前台窗口。";
  } catch (e) {
    el2.textContent = `读取状态失败：${String(e)}`;
  }
}
