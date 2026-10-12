// 插件运行时：manifest 扫描校验 → 动态 import → activate/deactivate 生命周期。
// 单插件异常被隔离，不影响宿主；启停清单存在宿主磁盘上（见 services/enabled.rs）。
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { bus } from "./event-bus";
import { buildContext, invalidatePermissions } from "./bridge";
import { pluginFileUrl, pluginFileVersion } from "./plugin-url";
import { widgetHost } from "./widget-host";
import { releaseAll } from "./resources";
import { disposeAll } from "./subscriptions";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  widget?: string;
  permissions?: string[];
  description?: string;
}

/**
 * 启停清单：事实来源在宿主（`services/enabled.rs`，原子写的一份 JSON 文件）。
 *
 * 原先它存在 WebView 的 localStorage 里 —— 清一次 WebView 缓存，用户给的启停就全没了，
 * 而这份清单决定「哪些插件会被激活」，属于跨会话状态（C1）。
 * 每个窗口各自持一份只读缓存：`loadEnabled()` 在开窗时取一次，取值仍是同步的
 * （reconcile 与 activate 的判定点都在热路径上，不该为它多等一次 IPC）。
 */
const LEGACY_ENABLED_KEY = "host:enabled-plugins";
let enabledCache: string[] = [];

/** 宿主还没写过（新安装，或老用户尚未迁移）时读到的那一份旧清单 */
function readLegacyEnabled(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_ENABLED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function getEnabled(): string[] {
  return enabledCache;
}

/**
 * 取宿主那份清单；还没有就先做一次迁移再落定。
 * 迁移命令只在「文件不存在」时写入，其余情况原样回读，所以多个窗口同时开也不会互相覆盖。
 * 以宿主回读的那份为准（非法 id 与重复项在宿主侧被滤掉），不自己猜过滤结果。
 */
export async function loadEnabled(): Promise<string[]> {
  const stored = await invoke<string[] | null>("plugin_enabled_list");
  if (stored) {
    enabledCache = stored;
    return enabledCache;
  }
  const legacy = readLegacyEnabled();
  try {
    enabledCache = await invoke<string[]>("plugin_enabled_migrate", { ids: legacy });
  } catch {
    // 老宿主没这条命令、或本窗不是宠物窗：至少按旧键那份继续跑，别把用户挡在门外
    enabledCache = legacy;
  }
  return enabledCache;
}

/** 写启停清单（只认设置窗，宿主会拒），并同步本窗缓存 —— 调用方需要 await 它 */
export async function setEnabledIds(ids: string[]): Promise<void> {
  const stored = await invoke<string[]>("plugin_enabled_set", { ids });
  enabledCache = stored;
}

/**
 * 每个窗口启动时挂一次：清单被任何窗口（包括直接打宿主命令的回归脚本）改过时，
 * 本窗那份缓存要跟着刷新。少了这一步，设置页会拿着旧名单判定「这个插件没启用」，
 * 于是插件页不挂 widget —— 表现成「明明开了开关，页面却是空的」。
 */
export async function watchEnabled(): Promise<void> {
  await listen<string[]>("host:enabled-changed", (e) => {
    if (Array.isArray(e.payload)) enabledCache = e.payload;
  });
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

/**
 * 每个插件一条串行执行链。
 *
 * activate 里有两处会长时间等待：用户点同意框、动态 import。此前它们不设防，
 * 于是「等同意框期间把开关关掉」会走完 activate 却没人 deactivate 它（当时它还不算 active），
 * 两个事件源（开关 + 目录变动）并发也可能把 activate 跑两遍。排队到同一条链上，
 * 启停就是可预期的先后顺序，而不是交错的竞态。
 */
const chains = new Map<string, Promise<void>>();

function enqueue<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(pluginId) ?? Promise.resolve();
  const run = prev.then(task, task);
  // 链尾吞掉结果：上一次的失败不该让下一次的启停直接 reject
  chains.set(
    pluginId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function reportError(plugin: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[runtime] ${plugin}:`, error);
  void emit("host:plugin-error", { plugin, error: message });
}

export function isActive(pluginId: string): boolean {
  return active.has(pluginId);
}

export function activatePlugin(manifest: PluginManifest): Promise<void> {
  return enqueue(manifest.id, () => doActivate(manifest));
}

export function deactivatePlugin(pluginId: string): Promise<void> {
  return enqueue(pluginId, () => doDeactivate(pluginId));
}

async function doActivate(manifest: PluginManifest): Promise<void> {
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
    // 弹框期间开关可能已经被关掉：那就别把一个「已被停用」的插件装起来。
    // 这里必须向宿主重取，而不是读本窗那份缓存 —— 缓存只保证「最终会被广播追平」，
    // 而直接调用 activatePlugin 的路子（回归脚本、watcher 之外的任何一处）可能刚由
    // 别的窗口写过清单，读旧缓存会把一个确实启用的插件判成停用。
    if (!(await loadEnabled()).includes(manifest.id)) return;

    const bust = await pluginFileVersion(manifest.id, manifest.entry);
    const url = pluginFileUrl(manifest.id, manifest.entry, bust);
    const mod = (await import(/* @vite-ignore */ url)) as ActiveInstance["module"];
    await mod.activate?.(buildContext(manifest));
    active.set(manifest.id, { manifest, module: mod });
    // 宠物窗负责徽标区；settings/overlay 窗自行挂载各自区域
    await widgetHost.mount(manifest, "badge");
  } catch (err) {
    reportError(manifest.id, err);
  }
}

async function doDeactivate(pluginId: string): Promise<void> {
  const instance = active.get(pluginId);
  if (!instance) return;
  active.delete(pluginId);
  try {
    await instance.module.deactivate?.();
  } catch (err) {
    reportError(pluginId, err);
  }
  // 插件自己漏掉的订阅由宿主兜底回收：留着闭包收事件，它捕获的界面也 GC 不掉
  disposeAll(pluginId);
  await widgetHost.unmount(pluginId);
  // 只回收该插件确实持有、且已无其他持有者的共享资源。
  // 早先这里是无条件 ble_disconnect + stop_scan，会掐断别的插件正在用的会话。
  const freed = releaseAll(pluginId);
  try {
    if (freed.ble) await invoke("ble_disconnect", { pluginId });
    if (freed["ble-scan"]) await invoke("ble_stop_scan", { pluginId });
    // 悬浮窗是这个插件为自己开的，它停了就整扇收掉，不涉及别的插件。
    // 走宿主的回收通道而不是插件面的 overlay_destroy：撤销授权之后能力已经没了，
    // 那条命令会被门禁挡住，窗就永远留在桌面上。
    await invoke("overlay_reclaim", { pluginId });
  } catch (err) {
    reportError(pluginId, err);
  }
}

/** 按持久化的启用清单同步实际运行状态 */
export async function reconcile(manifests: PluginManifest[]): Promise<void> {
  // 每次都向宿主取一遍：清单的事实来源在宿主，本窗那份缓存可能已经被别的窗口写过
  const enabled = new Set(await loadEnabled());
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
  // 先挂监听再取清单：反过来的话中间那次变更会被丢掉
  await watchEnabled();
  // 启停清单要先取到：reconcile 与 activate 都读那份同步缓存，取空了会把用户启用的插件全当停用
  await loadEnabled();
  await bus.init();
  // 宿主 Rust 原生事件注入总线，插件经标准 topic 订阅
  await listen("ble:device-found", (e) => bus.inject("ble:device-found", e.payload));
  await listen("ble:heart-rate", (e) => bus.inject("ble:heart-rate", e.payload));
  await listen("ble:disconnected", (e) => bus.inject("ble:disconnected", e.payload));
  await listen("ble:error", (e) => bus.inject("ble:error", e.payload));
  // Agent hook 事件（Rust 侧 watcher 归一化后广播）
  await listen("agent:state", (e) => bus.inject("agent:state", e.payload));
  await listen("agent:event", (e) => bus.inject("agent:event", e.payload));
  // 设置窗切换插件开关 → 本窗运行时执行启停
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", async (e) => {
    const { id, enabled } = e.payload;
    // 清单的事实来源在宿主：本窗那份缓存要跟着刷新，否则下一次 reconcile
    // 会拿旧名单把刚被停用的插件又激活回来
    await loadEnabled();
    const manifests = await invoke<PluginManifest[]>("plugins_list");
    const manifest = manifests.find((m) => m.id === id);
    if (!manifest) return;
    if (enabled) {
      await activatePlugin(manifest);
    } else {
      await deactivatePlugin(id);
    }
  });
  // 撤销授权后必须丢掉桥的能力缓存，否则已经加载的插件还能继续用它刚被收回的权限
  await listen<string>("host:permission-revoked", (e) => {
    invalidatePermissions(e.payload);
  });
  // 插件目录变动（放入/移除插件）即时生效，不必重启宿主
  await listen("host:plugins-changed", async () => {
    await reconcile(await invoke<PluginManifest[]>("plugins_list"));
  });
  await reconcile(await invoke<PluginManifest[]>("plugins_list"));
}
