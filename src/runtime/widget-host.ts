// Widget 宿主：每个插件的 widget 运行在独立 Shadow DOM 中，样式与 DOM 互相隔离。
// 插件不得直接操作宿主 DOM/画布，只能拿到自己 Shadow Root 的挂载入口；
// widget 能力（事件总线）由宿主经 ctx 注入，widget.js 自身保持零 import，
// 这样 dev（vite 转换）与 release（静态文件）下都能加载。
import { bus } from "./event-bus";

export interface WidgetExports {
  mount: (
    root: ShadowRoot,
    ctx: { pluginId: string; region: string; bus: typeof bus },
  ) => void | Promise<void>;
  unmount?: (root: ShadowRoot) => void | Promise<void>;
}

interface MountRecord {
  host: HTMLDivElement;
  mod: WidgetExports;
  shadow: ShadowRoot;
}

class WidgetHost {
  private mounted = new Map<string, MountRecord[]>(); // pluginId → 该窗口内已挂载插槽

  /** 把插件 widget 挂载到指定区域；容器缺省按 id 约定 widget-<region> 查找 */
  async mount(
    manifest: { id: string; widget?: string },
    region: string,
    container?: HTMLElement,
  ): Promise<void> {
    if (!manifest.widget || this.has(manifest.id, region)) return;
    const root = container ?? document.getElementById(`widget-${region}`);
    if (!root) return;

    const url = `/plugins/${manifest.id}/${manifest.widget}`;
    const mod = (await import(/* @vite-ignore */ url)) as WidgetExports;
    if (typeof mod.mount !== "function") {
      throw new Error(`widget.js 缺少 mount() 导出: ${url}`);
    }

    const host = document.createElement("div");
    host.dataset.pluginId = manifest.id;
    host.dataset.region = region;
    const shadow = host.attachShadow({ mode: "closed" });
    root.appendChild(host);

    await mod.mount(shadow, { pluginId: manifest.id, region, bus });

    const list = this.mounted.get(manifest.id) ?? [];
    list.push({ host, mod, shadow });
    this.mounted.set(manifest.id, list);
  }

  has(pluginId: string, region?: string): boolean {
    const list = this.mounted.get(pluginId);
    if (!list) return false;
    if (!region) return list.length > 0;
    return list.some((m) => m.host.dataset.region === region);
  }

  async unmount(pluginId: string): Promise<void> {
    const list = this.mounted.get(pluginId);
    if (!list) return;
    this.mounted.delete(pluginId);
    for (const record of list) {
      try {
        await record.mod.unmount?.(record.shadow);
      } catch (err) {
        console.error(`[widget] unmount error: ${pluginId}`, err);
      }
      record.host.remove();
    }
  }
}

export const widgetHost = new WidgetHost();
