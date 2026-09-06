// overlay 悬浮窗：加载已启用插件的 overlay 区 widget（透明、点击穿透由宿主窗口保证）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "../runtime/event-bus";
import { getEnabled, type PluginManifest } from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import "./style.css";

async function mountEnabled(): Promise<void> {
  const manifests = await invoke<PluginManifest[]>("plugins_list");
  const enabled = new Set(getEnabled());
  for (const manifest of manifests) {
    if (enabled.has(manifest.id) && manifest.widget) {
      await widgetHost.mount(manifest, "overlay").catch((e) => {
        console.error(`[overlay] mount widget: ${manifest.id}`, e);
      });
    }
  }
}

async function main(): Promise<void> {
  await bus.init();
  await mountEnabled();

  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", async (e) => {
    if (!e.payload.enabled) {
      await widgetHost.unmount(e.payload.id);
      return;
    }
    const manifests = await invoke<PluginManifest[]>("plugins_list");
    const manifest = manifests.find((m) => m.id === e.payload.id);
    if (manifest?.widget) {
      await widgetHost.mount(manifest, "overlay").catch(console.error);
    }
  });
}

void main();
