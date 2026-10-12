// PetAPI 能力桥：按 manifest 权限逐项校验，未授权时触发同意框，拒绝默认。
// 进程内插件不是硬安全边界，这里是策略层（见 ARCHITECTURE.md 信任模型）。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "./event-bus";
import { PET_ACTIONS, petController, type ActionName } from "../pet/host";
import { claim, release } from "./resources";
import { register } from "./subscriptions";
import { assertPublishable, assertSubscribable } from "./topic-acl";

function requireController() {
  const controller = petController();
  if (!controller) throw new Error("宠物本体尚未初始化完成");
  return controller;
}

// 插件为普通 JS（第三方交付物），上下文保持宽松类型
// biome-ignore lint/suspicious/noExplicitAny: PluginContext 的形状由 manifest 动态决定，SDK 侧的类型面见 packages/sdk（K1）
export type PluginContext = any;

interface ManifestLike {
  id: string;
  name: string;
  permissions?: string[];
}

/**
 * 会话内已授权能力缓存（插件 id → 能力名）。
 * 心率这类插件每秒要过好几项能力，逐次问宿主就是一串没有必要的 IPC；
 * 撤销授权时由 runtime 监听 `host:permission-revoked` 清掉对应条目。
 */
const granted = new Map<string, Set<string>>();

// 撤销授权后必须丢掉**本窗口**的桥缓存。运行时（宠物窗）的监听在 plugin-runtime 里，
// 但设置窗里的插件设置页用的是本窗口的模块实例，而撤销入口就在设置窗 —— 漏了这条，
// 缓存会一直说「已授权」，设置区插件的下一次调用要等整窗重载才会重新走能力校验。
void listen<string>("host:permission-revoked", (e) => invalidatePermissions(e.payload)).catch(() => undefined);

export function invalidatePermissions(pluginId?: string): void {
  if (pluginId) granted.delete(pluginId);
  else granted.clear();
}

export function grantedCapabilities(pluginId: string): string[] {
  return [...(granted.get(pluginId) ?? [])];
}

/** 一次弹框申请多个能力（http 需要 http + http:<host> 两级，不该弹两次） */
async function ensurePermissions(manifest: ManifestLike, capabilities: string[]): Promise<boolean> {
  const pid = manifest.id;
  const known = granted.get(pid) ?? new Set<string>();
  const uncached = capabilities.filter((capability) => !known.has(capability));

  // 缓存说「没授权」时仍要问宿主一次：授权表是宿主的事实，可能已被别处改动
  const missing: string[] = [];
  for (const capability of uncached) {
    const ok = await invoke<boolean>("permission_check", { pluginId: pid, capability });
    if (ok) known.add(capability);
    else missing.push(capability);
  }
  if (missing.length === 0) {
    granted.set(pid, known);
    return true;
  }
  const accepted = await invoke<boolean>("permission_request", {
    pluginId: pid,
    pluginName: manifest.name,
    capabilities: missing,
  });
  if (accepted) {
    for (const capability of missing) known.add(capability);
    granted.set(pid, known);
  }
  return accepted;
}

async function ensurePermission(manifest: ManifestLike, capability: string): Promise<boolean> {
  return ensurePermissions(manifest, [capability]);
}

/** 包装一个能力方法：调用前校验权限 */
function gated<A extends unknown[], R>(
  manifest: ManifestLike,
  capability: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    if (!(await ensurePermission(manifest, capability))) {
      throw new Error(`[${manifest.id}] 权限被拒绝: ${capability}`);
    }
    return fn(...args);
  };
}

/** 插件设置页专属能力：查询/安装/卸载本机编码 Agent（Qoder）的 hook 配置（见 ADR-0001） */
export const AGENT_HOOKS_CAP = "agent:hooks";

/**
 * settings 区 widget 的受控宿主通道。只在 `widget-host.ts` 里当
 * `ctx.host.agentHooks` 注入 —— 这是本卡唯一的新攻击面，别在这里扩大面。
 */
export function createAgentHooksApi(manifest: ManifestLike) {
  return {
    status: gated(manifest, AGENT_HOOKS_CAP, () => invoke<unknown>("agent_hooks_status", { pluginId: manifest.id })),
    install: gated(manifest, AGENT_HOOKS_CAP, () => invoke<unknown>("agent_hooks_install", { pluginId: manifest.id })),
    uninstall: gated(manifest, AGENT_HOOKS_CAP, () => invoke<unknown>("agent_hooks_uninstall", { pluginId: manifest.id })),
  };
}

export function buildContext(manifest: ManifestLike): PluginContext {
  const pid = manifest.id;
  const storage = {
    get: (key: string) => invoke("store_get", { pluginId: pid, key }),
    set: (key: string, value: unknown) => invoke("store_set", { pluginId: pid, key, value }),
    delete: (key: string) => invoke("store_delete", { pluginId: pid, key }),
  };
  return {
    pluginId: pid,
    log: (...args: unknown[]) => console.log(`[${pid}]`, ...args),

    bus: {
      publish: gated(manifest, "bus:publish", (topic: string, payload: unknown) => {
        assertPublishable(pid, topic);
        // 带上 pid：宿主要按它校验 topic 前缀与 bus:publish 授权（见 commands/bus.rs）
        return Promise.resolve(bus.publish(topic, payload, pid));
      }),
      /** 返回退订函数（先 await 才拿到）。停用插件时宿主统一回收，见 runtime/subscriptions.ts */
      subscribe: gated(manifest, "bus:subscribe", (topic: string, handler: (payload: unknown) => void) => {
        assertSubscribable(pid, topic, manifest.permissions ?? []);
        const off = bus.subscribe(topic, handler);
        return Promise.resolve(register(pid, off));
      }),
    },

    storage: {
      get: gated(manifest, "storage", (key: string) => storage.get(key) as Promise<unknown>),
      set: gated(manifest, "storage", (key: string, value: unknown) => storage.set(key, value)),
      delete: gated(manifest, "storage", (key: string) => storage.delete(key)),
    },

    ble: {
      startScan: gated(manifest, "ble:scan", async () => {
        // 先 claim 是对的（并发时不该有两个「开始扫描」），但失败必须对称回滚：
        // 留着幽灵持有者的话，真正在扫的那个 release 时永远返回 false，扫描就停不下来
        claim("ble-scan", pid);
        try {
          await invoke("ble_start_scan", { pluginId: pid });
        } catch (err) {
          release("ble-scan", pid);
          throw err;
        }
      }),
      stopScan: gated(manifest, "ble:scan", async () => {
        // 仍有别的插件在扫就不该真的停
        if (release("ble-scan", pid)) await invoke("ble_stop_scan", { pluginId: pid });
      }),
      connect: gated(manifest, "ble:connect", async (deviceId: string) => {
        claim("ble", pid);
        try {
          await invoke("ble_connect", { pluginId: pid, deviceId });
        } catch (err) {
          release("ble", pid);
          throw err;
        }
      }),
      disconnect: gated(manifest, "ble:connect", async () => {
        if (release("ble", pid)) await invoke("ble_disconnect", { pluginId: pid });
      }),
      connectedDevice: gated(manifest, "ble:connect", () =>
        invoke("ble_connected_device", { pluginId: pid }),
      ),
    },

    // widget 数据下发：以 `${pluginId}:widget` topic 广播，widget.js 自行订阅
    widget: {
      update: gated(manifest, "widget", (data: unknown) =>
        Promise.resolve(bus.publish(`${pid}:widget`, data, pid)),
      ),
    },

    // 影响宠物本体：插播动作 / 弹台词气泡（本体只暴露这两个受控入口，不给 canvas/DOM）
    pet: {
      react: gated(manifest, "pet:react", async (action: unknown) => {
        if (!PET_ACTIONS.includes(action as ActionName)) {
          throw new Error(`[${pid}] 未知宠物动作: ${String(action)}`);
        }
        requireController().react(action as ActionName);
      }),
      say: gated(manifest, "pet:say", async (text: unknown) => {
        const clean = String(text ?? "")
          .replace(/\s*\n\s*/g, " ")
          .trim()
          .slice(0, 200);
        if (!clean) throw new Error(`[${pid}] say 需要非空文本内容`);
        requireController().say(clean);
      }),
    },

    // 出站请求：域名逐个授权（http + http:<host>），实际请求由宿主代发并二次校验 host
    http: {
      request: async (
        url: string,
        options: { method?: string; headers?: [string, string][]; body?: string } = {},
      ) => {
        let host: string;
        try {
          host = new URL(url).host;
        } catch {
          throw new Error(`[${pid}] URL 非法: ${url}`);
        }
        if (!(await ensurePermissions(manifest, ["http", `http:${host}`]))) {
          throw new Error(`[${pid}] 域名授权被拒绝: ${host}`);
        }
        return invoke("http_request", {
          pluginId: pid,
          url,
          method: options.method ?? null,
          headers: options.headers ?? null,
          body: options.body ?? null,
        });
      },
    },

    notify: {
      show: gated(manifest, "notify", (title: string, body: string) =>
        invoke("notify_show", { pluginId: pid, title, body }),
      ),
    },

    overlay: {
      // 每个插件一扇自己的悬浮窗（标签 overlay-<id>）：位置、高度、显隐互不影响，
      // 不再是谁先 show 谁定这扇窗
      show: gated(manifest, "overlay", async (options: { placement?: string; height?: number } = {}) => {
        await invoke("overlay_show", {
          pluginId: pid,
          placement: options.placement ?? null,
          height: options.height ?? null,
        });
      }),
      hide: gated(manifest, "overlay", async () => {
        await invoke("overlay_hide", { pluginId: pid });
      }),
      destroy: gated(manifest, "overlay", async () => {
        await invoke("overlay_destroy", { pluginId: pid });
      }),
    },
  };
}
