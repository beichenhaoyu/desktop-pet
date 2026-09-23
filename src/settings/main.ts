import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { bus } from "../runtime/event-bus";
import {
  getEnabled,
  setEnabledIds,
  validateManifest,
  type PluginManifest,
} from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import "./style.css";

interface Elements {
  card: HTMLElement;
  toggle: HTMLInputElement;
  settingsBox: HTMLElement;
}

const rows = new Map<string, Elements>();
let banner: HTMLElement | null = null;

function buildCard(manifest: PluginManifest, enabled: boolean): Elements {
  const card = document.createElement("section");
  card.className = "plugin-card" + (enabled ? " enabled" : "");

  const head = document.createElement("div");
  head.className = "plugin-head";

  const title = document.createElement("div");
  title.className = "plugin-title";
  const name = document.createElement("span");
  name.className = "plugin-name";
  name.textContent = manifest.name;
  const ver = document.createElement("span");
  ver.className = "plugin-version";
  ver.textContent = `v${manifest.version}`;
  title.append(name, ver);

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.checked = enabled;

  head.append(title, toggle);

  const idLine = document.createElement("div");
  idLine.className = "plugin-id";
  idLine.textContent = manifest.id;
  if (manifest.description) {
    const desc = document.createElement("div");
    desc.className = "plugin-desc";
    desc.textContent = manifest.description;
    card.append(head, idLine, desc);
  } else {
    card.append(head, idLine);
  }

  // 权限列表 + 撤销授权
  const perms = manifest.permissions ?? [];
  if (perms.length > 0) {
    const permRow = document.createElement("div");
    permRow.className = "perm-row";
    for (const p of perms) {
      const chip = document.createElement("span");
      chip.className = "perm-chip";
      chip.textContent = p;
      permRow.append(chip);
    }
    const revoke = document.createElement("button");
    revoke.className = "btn-revoke";
    revoke.textContent = "撤销授权";
    revoke.addEventListener("click", async () => {
      await invoke("permission_revoke", { pluginId: manifest.id });
      revoke.textContent = "已撤销";
      revoke.disabled = true;
    });
    permRow.append(revoke);
    card.append(permRow);
  }

  // 插件自带设置区（Shadow DOM 插槽）
  const settingsBox = document.createElement("div");
  settingsBox.className = "plugin-settings";
  settingsBox.style.display = enabled ? "" : "none";
  card.append(settingsBox);

  toggle.addEventListener("change", async () => {
    const on = toggle.checked;
    const ids = new Set(getEnabled());
    if (on) ids.add(manifest.id);
    else ids.delete(manifest.id);
    setEnabledIds([...ids]);
    card.classList.toggle("enabled", on);
    settingsBox.style.display = on ? "" : "none";
    if (on) {
      // 立即挂载插件自带设置面板（不等宠物窗的插件激活）
      widgetHost.mount(manifest, "settings", settingsBox).catch((e) => {
        console.error(`[settings] mount widget: ${manifest.id}`, e);
      });
    } else {
      await widgetHost.unmount(manifest.id);
    }
    // 通知宠物窗运行时启停（overlay/settings 窗各自监听同一事件挂载 widget）
    await emit("host:plugin-toggled", { id: manifest.id, enabled: on });
  });

  return { card, toggle, settingsBox };
}

async function render(): Promise<void> {
  const manifests = await invoke<PluginManifest[]>("plugins_list");
  const enabled = new Set(getEnabled());
  const list = document.getElementById("plugin-list")!;
  // 重建 DOM 前必须先卸载 widget：否则 mounted 表里留着已消失的插槽，
  // 之后 has() 会抑制重挂载，面板静默不见
  for (const id of rows.keys()) await widgetHost.unmount(id);
  list.innerHTML = "";
  rows.clear();

  const sorted = [...manifests].sort((a, b) => a.id.localeCompare(b.id));
  for (const manifest of sorted) {
    const invalid = validateManifest(manifest);
    if (invalid) {
      const err = document.createElement("section");
      err.className = "plugin-card error";
      err.textContent = `${manifest.id ?? "?"}：${invalid}`;
      list.append(err);
      continue;
    }
    const on = enabled.has(manifest.id);
    const row = buildCard(manifest, on);
    rows.set(manifest.id, row);
    list.append(row.card);
    if (on) {
      widgetHost.mount(manifest, "settings", row.settingsBox).catch((e) => {
        console.error(`[settings] mount widget: ${manifest.id}`, e);
      });
    }
  }
}

async function main(): Promise<void> {
  await bus.init();
  await render();

  // 宠物窗运行时上报的插件异常 → 顶部红条
  banner = document.createElement("div");
  banner.className = "error-banner";
  banner.style.display = "none";
  document.getElementById("app")!.prepend(banner);
  await listen<{ plugin: string; error: string }>("host:plugin-error", (e) => {
    if (!banner) return;
    banner.textContent = `插件异常已隔离 — ${e.payload.plugin}: ${e.payload.error}`;
    banner.style.display = "";
  });

  // 插件目录变动 → 重新拉列表（新增/移除即时可见）
  await listen("host:plugins-changed", () => {
    void render().catch((e) => console.error("[settings] render", e));
  });

  // 其他窗口触发的启停（目前只有设置窗自己，保留下述同步逻辑以防扩展）
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", (e) => {
    const row = rows.get(e.payload.id);
    if (!row || e.payload.enabled) return;
    widgetHost.unmount(e.payload.id);
  });
}

void main();
