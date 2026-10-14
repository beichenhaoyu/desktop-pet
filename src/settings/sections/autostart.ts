import { hostCall, hostErrorMessage } from "../../runtime/host-error";
import { $ } from "../dom";

/* ---------- 开机自启 ---------- */

export async function renderAutostart(): Promise<void> {
  const box = $<HTMLInputElement>("autostart-switch");
  const el2 = $<HTMLElement>("autostart-status");
  if (!box || !el2) return;
  try {
    const info = await hostCall<{ enabled: boolean; exe: string; devBuild: boolean }>("autostart_status");
    box.checked = info.enabled;
    el2.textContent = info.devBuild
      ? `当前跑的是开发构建，注册的是 ${info.exe} —— 换正式包后请重新打开一次这个开关。`
      : `启动项指向 ${info.exe}`;
  } catch (e) {
    el2.textContent = `读取失败：${hostErrorMessage(e)}`;
  }
}

export function wireStartup(): void {
  const box = $<HTMLInputElement>("autostart-switch");
  box?.addEventListener("change", async () => {
    const el2 = $<HTMLElement>("autostart-status");
    const want = box.checked;
    try {
      const now = await hostCall<boolean>("autostart_set", { enabled: want });
      box.checked = now;
      if (el2) el2.textContent = now ? "已加入登录启动项。" : "已移除登录启动项。";
    } catch (e) {
      box.checked = !want;
      if (el2) el2.textContent = `改动失败：${hostErrorMessage(e)}`;
    }
  });
}
