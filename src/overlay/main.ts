// 悬浮窗：每扇只挂**它自己的那个插件**的 overlay widget。
// 窗口是按插件建的（标签 overlay-<插件 id>），所以这里不再遍历全部启用插件 ——
// 那样会把别人的卡片叠进同一扇窗。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "../runtime/event-bus";
import { loadEnabled, type PluginManifest } from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import "./style.css";

/** 归属由宿主按窗口标签回查（标签是净化过的，点号不能原样保留） */
let pluginId = "";
let mounted = false;

async function sync(): Promise<void> {
  if (!pluginId) {
    pluginId = (await invoke<string | null>("overlay_owner")) ?? "";
  }
  if (!pluginId) {
    console.error(`[overlay] 宿主不认识窗口 ${getCurrentWindow().label}，不知道要显示谁的卡片`);
    return;
  }
  // 多扇悬浮窗在 CDP / 任务管理器里要分得清是谁的：document.title 就是 CDP 看到的标题
  document.title = `DesktopPet Overlay · ${pluginId}`;
  const manifests = await invoke<PluginManifest[]>("plugins_list");
  // 启停清单向宿主取（C1）：本窗是新开的，缓存还没落地
  const enabled = new Set(await loadEnabled());
  const mine = manifests.find((m) => m.id === pluginId);
  if (!mine?.widget || !enabled.has(pluginId)) {
    // 插件被停用或删除：这扇窗是它为卡片开的，收掉自己
    await widgetHost.unmount(pluginId).catch(() => undefined);
    mounted = false;
    await getCurrentWindow().close().catch(() => undefined);
    return;
  }
  if (mounted || widgetHost.has(pluginId, "overlay")) return;
  mounted = true;
  await widgetHost.mount(mine, "overlay").catch((e) => {
    mounted = false;
    console.error(`[overlay] mount widget: ${mine.id}`, e);
  });
}

async function main(): Promise<void> {
  await bus.init();
  await sync();

  // 启停与目录增删都收敛到一次同步（清单的事实来源在宿主，sync 每次都去取）
  await listen("host:enabled-changed", () => void sync().catch(console.error));
  await listen("host:plugin-toggled", () => void sync().catch(console.error));
  await listen("host:plugins-changed", () => void sync().catch(console.error));
}

void main();
