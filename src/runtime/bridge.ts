// PetAPI 能力桥：按 manifest 权限逐项校验，未授权时触发同意框，拒绝默认。
// 进程内插件不是硬安全边界，这里是策略层（见 ARCHITECTURE.md 信任模型）。
import { invoke } from "@tauri-apps/api/core";
import { bus } from "./event-bus";
import { PET_ACTIONS, petController, type ActionName } from "../pet/host";
import { claim, release } from "./resources";
import { assertPublishable, assertSubscribable } from "./topic-acl";

function requireController() {
  const controller = petController();
  if (!controller) throw new Error("宠物本体尚未初始化完成");
  return controller;
}

// 插件为普通 JS（第三方交付物），上下文保持宽松类型
/* eslint-disable @typescript-eslint/no-explicit-any */
export type PluginContext = any;

interface ManifestLike {
  id: string;
  name: string;
  permissions?: string[];
}

async function ensurePermission(manifest: ManifestLike, capability: string): Promise<boolean> {
  return ensurePermissions(manifest, [capability]);
}

/** 一次弹框申请多个能力（http 需要 http + http:<host> 两级，不该弹两次） */
async function ensurePermissions(manifest: ManifestLike, capabilities: string[]): Promise<boolean> {
  const missing: string[] = [];
  for (const capability of capabilities) {
    const granted = await invoke<boolean>("permission_check", {
      pluginId: manifest.id,
      capability,
    });
    if (!granted) missing.push(capability);
  }
  if (missing.length === 0) return true;
  return invoke<boolean>("permission_request", {
    pluginId: manifest.id,
    pluginName: manifest.name,
    capabilities: missing,
  });
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
        return Promise.resolve(bus.publish(topic, payload));
      }),
      subscribe: gated(manifest, "bus:subscribe", (topic: string, handler: (payload: unknown) => void) => {
        assertSubscribable(pid, topic, manifest.permissions ?? []);
        return Promise.resolve(bus.subscribe(topic, handler));
      }),
    },

    storage: {
      get: gated(manifest, "storage", (key: string) => storage.get(key) as Promise<unknown>),
      set: gated(manifest, "storage", (key: string, value: unknown) => storage.set(key, value)),
      delete: gated(manifest, "storage", (key: string) => storage.delete(key)),
    },

    ble: {
      startScan: gated(manifest, "ble:scan", async () => {
        claim("ble-scan", pid);
        await invoke("ble_start_scan");
      }),
      stopScan: gated(manifest, "ble:scan", async () => {
        // 仍有别的插件在扫就不该真的停
        if (release("ble-scan", pid)) await invoke("ble_stop_scan");
      }),
      connect: gated(manifest, "ble:connect", async (deviceId: string) => {
        claim("ble", pid);
        await invoke("ble_connect", { deviceId });
      }),
      disconnect: gated(manifest, "ble:connect", async () => {
        if (release("ble", pid)) await invoke("ble_disconnect");
      }),
      connectedDevice: gated(manifest, "ble:connect", () =>
        invoke("ble_connected_device"),
      ),
    },

    // widget 数据下发：以 `${pluginId}:widget` topic 广播，widget.js 自行订阅
    widget: {
      update: gated(manifest, "widget", (data: unknown) =>
        Promise.resolve(bus.publish(`${pid}:widget`, data)),
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
        if (!clean) throw new Error(`[${pid}] say 需要非文本内容`);
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
      show: gated(manifest, "overlay", async () => {
        claim("overlay", pid);
        await invoke("overlay_show");
      }),
      hide: gated(manifest, "overlay", async () => {
        // overlay 是全插件共享的单窗，只有最后一个持有者退出才收掉
        if (release("overlay", pid)) await invoke("overlay_hide");
      }),
      destroy: gated(manifest, "overlay", async () => {
        if (release("overlay", pid)) await invoke("overlay_destroy");
      }),
    },
  };
}
