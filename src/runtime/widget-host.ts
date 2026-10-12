// Widget 宿主：每个插件的 widget 运行在独立 Shadow DOM 中，样式与 DOM 互相隔离。
// 插件不得直接操作宿主 DOM/画布，只能拿到自己 Shadow Root 的挂载入口；
// widget 能力（事件总线）由宿主经 ctx 注入为受限视图。
// widget 与插件其余文件一样经 petplugin 协议按目录提供，因此可以用相对 import
// 拆分子模块（示例插件把 topic 常量抽进 topics.js 就是这个用法）。
import { bus } from "./event-bus";
import { pluginFileUrl, pluginFileVersion } from "./plugin-url";
import { createScopedBus } from "./topic-acl";
import { createAgentHooksApi } from "./bridge";
import type { WidgetContext, WidgetRegion } from "../../packages/sdk";

export interface WidgetManifest {
  id: string;
  name?: string;
  widget?: string;
  permissions?: string[];
}

export interface WidgetExports {
  mount: (
    root: ShadowRoot,
    ctx: WidgetContext,
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
  private mounting = new Map<string, Promise<void>>(); // `${id}#${region}` → 在途挂载
  /** 每次 unmount 递增：在途的挂载完成后据此判断「我该不该真的留下来」 */
  private epoch = new Map<string, number>();

  private epochOf(pluginId: string): number {
    return this.epoch.get(pluginId) ?? 0;
  }

  /** 把插件 widget 挂载到指定区域；容器缺省按 id 约定 widget-<region> 查找 */
  async mount(
    manifest: WidgetManifest,
    region: WidgetRegion,
    container?: HTMLElement,
  ): Promise<void> {
    const key = `${manifest.id}#${region}`;
    if (!manifest.widget || this.has(manifest.id, region) || this.mounting.has(key)) return;
    const root = container ?? document.getElementById(`widget-${region}`);
    if (!root) return;

    const startedAt = this.epochOf(manifest.id);
    const run = this.doMount(manifest, manifest.widget, region, root, startedAt);
    this.mounting.set(key, run);
    try {
      await run;
    } finally {
      this.mounting.delete(key);
    }
  }

  private async doMount(
    manifest: WidgetManifest,
    widgetPath: string,
    region: WidgetRegion,
    root: HTMLElement,
    startedAt: number,
  ): Promise<void> {
    const bust = await pluginFileVersion(manifest.id, widgetPath);
    const url = pluginFileUrl(manifest.id, widgetPath, bust);
    let host: HTMLDivElement | undefined;
    try {
      const mod = (await import(/* @vite-ignore */ url)) as WidgetExports;
      if (typeof mod.mount !== "function") {
        throw new Error(`widget.js 缺少 mount() 导出: ${url}`);
      }
      // 等 import 期间可能已经有人 unmount 过这个插件（设置窗重开、插件被停用）：
      // 那时 mounted 里还没有记录，unmount 管不到这次挂载，不复查就会留下挂在 DOM 上的孤儿
      if (this.epochOf(manifest.id) !== startedAt) return;

      host = document.createElement("div");
      host.dataset.pluginId = manifest.id;
      host.dataset.region = region;
      const shadow = host.attachShadow({ mode: "closed" });
      root.appendChild(host);

      const ctx: Parameters<WidgetExports["mount"]>[1] = {
        pluginId: manifest.id,
        region,
        bus: createScopedBus(manifest.id, manifest.permissions ?? [], bus),
      };
      // 受控宿主通道只往设置区注入：badge / overlay 区与宠物窗主 realm 都拿不到 ctx.host
      if (region === "settings") {
        ctx.host = {
          agentHooks: createAgentHooksApi({
            id: manifest.id,
            name: manifest.name ?? manifest.id,
            permissions: manifest.permissions,
          }),
        };
      }
      await mod.mount(shadow, ctx);

      if (this.epochOf(manifest.id) !== startedAt) {
        host.remove();
        return;
      }
      const list = this.mounted.get(manifest.id) ?? [];
      list.push({ host, mod, shadow });
      this.mounted.set(manifest.id, list);
      host = undefined; // 挂载成功，交由 mounted 管理
    } catch (err) {
      host?.remove(); // 半途失败的容器不能留下删不掉的孤儿节点
      throw err;
    }
  }

  has(pluginId: string, region?: WidgetRegion): boolean {
    const list = this.mounted.get(pluginId);
    if (!list) return false;
    if (!region) return list.length > 0;
    return list.some((m) => m.host.dataset.region === region);
  }

  async unmount(pluginId: string): Promise<void> {
    // 先作废这一轮的在途挂载，再等它们落地：顺序反了的话等的是一个「已经不算数」的 Promise
    this.epoch.set(pluginId, this.epochOf(pluginId) + 1);
    const inflight = [...this.mounting.entries()]
      .filter(([key]) => key.startsWith(`${pluginId}#`))
      .map(([, run]) => run.catch(() => undefined));
    if (inflight.length) await Promise.all(inflight);

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

  /** 在途挂载的插槽数（只读诊断，供回归断言竞态窗口） */
  get inflightCount(): number {
    return this.mounting.size;
  }
}

export const widgetHost = new WidgetHost();
