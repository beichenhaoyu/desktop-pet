import { emit } from "@tauri-apps/api/event";
import { getEnabled, setEnabledIds } from "../runtime/plugin-runtime";
import { $ } from "./dom";
import { applyFilter, renderNav } from "./nav";
import { renderPluginPage } from "./plugin-page";
import { manifests, selected } from "./state";

toggleListener();
export function toggleListener(): void {
  const toggle = $<HTMLInputElement>("plugin-toggle");
  toggle?.addEventListener("change", async () => {
    const manifest = manifests.find((m) => m.id === selected);
    if (!manifest) return;
    const on = toggle.checked === true;
    const ids = new Set(getEnabled());
    if (on) ids.add(manifest.id);
    else ids.delete(manifest.id);
    // 先落盘再广播：宠物窗收到 host:plugin-toggled 后会向宿主重取清单，
    // 顺序反了它取到的还是旧的那份，表现成「开关点不动」
    await setEnabledIds([...ids]);
    const label = $<HTMLSpanElement>("plugin-toggle-label");
    if (label) label.textContent = on ? "已启用" : "已停用";
    renderNav();
    applyFilter();
    await renderPluginPage();
    // 通知宠物窗运行时启停（overlay/settings 窗各自监听同一事件挂载 widget）
    await emit("host:plugin-toggled", { id: manifest.id, enabled: on });
  });
}
