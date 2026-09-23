// PetAPI 能力桥：按 manifest 权限逐项校验，未授权时触发同意框，拒绝默认。
// 进程内插件不是硬安全边界，这里是策略层（见 ARCHITECTURE.md 信任模型）。
import { invoke } from "@tauri-apps/api/core";
import { bus } from "./event-bus";
import { assertPublishable, assertSubscribable } from "./topic-acl";

// 插件为普通 JS（第三方交付物），上下文保持宽松类型
/* eslint-disable @typescript-eslint/no-explicit-any */
export type PluginContext = any;

interface ManifestLike {
  id: string;
  name: string;
  permissions?: string[];
}

async function ensurePermission(manifest: ManifestLike, capability: string): Promise<boolean> {
  const granted = await invoke<boolean>("permission_check", {
    pluginId: manifest.id,
    capability,
  });
  if (granted) return true;
  // 未授权 → 弹同意框（宿主阻塞等待用户决定）
  return invoke<boolean>("permission_request", {
    pluginId: manifest.id,
    pluginName: manifest.name,
    capabilities: [capability],
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
      startScan: gated(manifest, "ble:scan", () => invoke("ble_start_scan")),
      stopScan: gated(manifest, "ble:scan", () => invoke("ble_stop_scan")),
      connect: gated(manifest, "ble:connect", (deviceId: string) =>
        invoke("ble_connect", { deviceId }),
      ),
      disconnect: gated(manifest, "ble:connect", () => invoke("ble_disconnect")),
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

    overlay: {
      show: gated(manifest, "overlay", () => invoke("overlay_show")),
      hide: gated(manifest, "overlay", () => invoke("overlay_hide")),
      destroy: gated(manifest, "overlay", () => invoke("overlay_destroy")),
    },
  };
}
