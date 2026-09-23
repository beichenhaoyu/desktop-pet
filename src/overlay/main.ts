// overlay 悬浮窗：加载已启用插件的 overlay 区 widget（透明、点击穿透由宿主窗口保证）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "../runtime/event-bus";
import { getEnabled, type PluginManifest } from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import "./style.css";

// 本窗口已挂载的插件，用于目录变动时算出该卸载谁
const mounted = new Set<string>();

async function syncOverlays(): Promise<void> {
  const manifests = await invoke<PluginManifest[]>("plugins_list");
  const enabled = new Set(getEnabled());
  for (const id of [...mounted]) {
    if (!manifests.some((m) => m.id === id && enabled.has(id))) {
      await widgetHost.unmount(id);
      mounted.delete(id);
    }
  }
  for (const manifest of manifests) {
    if (enabled.has(manifest.id) && manifest.widget && !mounted.has(manifest.id)) {
      mounted.add(manifest.id);
      await widgetHost.mount(manifest, "overlay").catch((e) => {
        console.error(`[overlay] mount widget: ${manifest.id}`, e);
      });
    }
  }
}

async function main(): Promise<void> {
  await bus.init();
  await syncOverlays();

  // 启停与目录增删都收敛到一次同步（设置窗在 emit 前已写好启用清单）
  await listen("host:plugin-toggled", () => void syncOverlays().catch(console.error));
  await listen("host:plugins-changed", () => void syncOverlays().catch(console.error));
}

void main();
