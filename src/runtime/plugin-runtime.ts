// 插件运行时：manifest 扫描校验 → 动态 import → activate/deactivate 生命周期。
// 单插件异常被隔离，不影响宿主；启停状态持久化在 localStorage（同源全窗口共享）。
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { bus } from "./event-bus";
import { buildContext } from "./bridge";
import { pluginFileUrl } from "./plugin-url";
import { widgetHost } from "./widget-host";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  widget?: string;
  permissions?: string[];
  description?: string;
}

const ENABLED_KEY = "host:enabled-plugins";

export function getEnabled(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ENABLED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setEnabledIds(ids: string[]): void {
  localStorage.setItem(ENABLED_KEY, JSON.stringify(ids));
}

export function validateManifest(m: PluginManifest): string | null {
  if (!m || typeof m !== "object") return "manifest 不是对象";
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(m.id ?? "")) return `非法插件 id: ${m.id}`;
  if (!m.name || typeof m.name !== "string") return "缺少 name";
  if (!m.version || typeof m.version !== "string") return "缺少 version";
  if (!/^[\w.-]+\.js$/.test(m.entry ?? "")) return `非法 entry: ${m.entry}`;
  if (m.widget != null && !/^[\w.-]+\.js$/.test(m.widget)) return `非法 widget: ${m.widget}`;
  if (m.permissions != null && !Array.isArray(m.permissions)) return "permissions 必须是数组";
  return null;
}

interface ActiveInstance {
  manifest: PluginManifest;
  module: { activate?: (ctx: unknown) => Promise<void> | void; deactivate?: () => Promise<void> | void };
}

const active = new Map<string, ActiveInstance>();

function reportError(plugin: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[runtime] ${plugin}:`, error);
  void emit("host:plugin-error", { plugin, error: message });
}

export function isActive(pluginId: string): boolean {
  return active.has(pluginId);
}

export async function activatePlugin(manifest: PluginManifest): Promise<void> {
  const invalid = validateManifest(manifest);
  if (invalid) {
    reportError(manifest.id ?? "?", invalid);
    return;
  }
  if (active.has(manifest.id)) return;
  try {
    // 首次激活：就 manifest 声明的权限一次性弹同意框（之后逐项校验静默放行）
    const missing: string[] = [];
    for (const capability of manifest.permissions ?? []) {
      const granted = await invoke<boolean>("permission_check", {
        pluginId: manifest.id,
        capability,
      });
      if (!granted) missing.push(capability);
    }
    if (missing.length > 0) {
      const ok = await invoke<boolean>("permission_request", {
        pluginId: manifest.id,
        pluginName: manifest.name,
        capabilities: missing,
      });
      if (!ok) {
        reportError(manifest.id, "用户拒绝了权限申请（可在设置中重新授权）");
        return;
      }
    }

    const url = pluginFileUrl(manifest.id, manifest.entry);
    const mod = (await import(/* @vite-ignore */ url)) as ActiveInstance["module"];
    await mod.activate?.(buildContext(manifest));
    active.set(manifest.id, { manifest, module: mod });
    // 宠物窗负责徽标区；settings/overlay 窗自行挂载各自区域
    await widgetHost.mount(manifest, "badge");
  } catch (err) {
    reportError(manifest.id, err);
  }
}

export async function deactivatePlugin(pluginId: string): Promise<void> {
  const instance = active.get(pluginId);
  if (!instance) return;
  active.delete(pluginId);
  try {
    await instance.module.deactivate?.();
  } catch (err) {
    reportError(pluginId, err);
  }
  await widgetHost.unmount(pluginId);
  // 宿主兜底释放 BLE 资源（保证插件关闭后不占系统资源）
  try {
    await invoke("ble_disconnect");
    await invoke("ble_stop_scan");
  } catch {
    /* 无连接时忽略 */
  }
}

/** 按持久化的启用清单同步实际运行状态 */
export async function reconcile(manifests: PluginManifest[]): Promise<void> {
  const enabled = new Set(getEnabled());
  // 目录被移走的插件必须真正下线：它已经不在 manifests 里，下面的循环管不到它
  const installed = new Set(manifests.map((m) => m.id));
  for (const id of [...active.keys()]) {
    if (!installed.has(id)) await deactivatePlugin(id);
  }
  for (const manifest of manifests) {
    if (enabled.has(manifest.id)) {
      await activatePlugin(manifest);
    } else {
      await deactivatePlugin(manifest.id);
    }
  }
}

/** 宠物窗（主上下文）启动入口 */
export async function initRuntime(): Promise<void> {
  await bus.init();
  // 宿主 Rust 原生事件注入总线，插件经标准 topic 订阅
  await listen("ble:device-found", (e) => bus.inject("ble:device-found", e.payload));
  await listen("ble:heart-rate", (e) => bus.inject("ble:heart-rate", e.payload));
  await listen("ble:disconnected", (e) => bus.inject("ble:disconnected", e.payload));
  await listen("ble:error", (e) => bus.inject("ble:error", e.payload));
  // 设置窗切换插件开关 → 本窗运行时执行启停
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", async (e) => {
    const { id, enabled } = e.payload;
    const manifests = await invoke<PluginManifest[]>("plugins_list");
    const manifest = manifests.find((m) => m.id === id);
    if (!manifest) return;
    if (enabled) {
      await activatePlugin(manifest);
    } else {
      await deactivatePlugin(id);
    }
  });
  // 插件目录变动（放入/移除插件）即时生效，不必重启宿主
  await listen("host:plugins-changed", async () => {
    await reconcile(await invoke<PluginManifest[]>("plugins_list"));
  });
  await reconcile(await invoke<PluginManifest[]>("plugins_list"));
}
