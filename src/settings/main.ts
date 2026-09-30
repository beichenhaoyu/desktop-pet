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

interface AgentFileReport {
  path: string;
  managed: number;
  error: string | null;
}

interface AgentStatus {
  exe: string;
  files: AgentFileReport[];
  managed: number;
  installed: boolean;
  expectedPerFile: number;
}

const agentStatusLine = () => document.getElementById("agent-status");
const agentDetail = () => document.getElementById("agent-detail");

async function renderAgent(): Promise<void> {
  const status = agentStatusLine();
  const detail = agentDetail();
  if (!status || !detail) return;
  try {
    const info = await invoke<AgentStatus>("agent_hooks_status");
    if (info.files.length === 0) {
      status.textContent = "未找到 Qoder 配置目录（~/.qoder 或 ~/.qoder-cn），本机没装对应客户端。";
      detail.textContent = "";
    } else if (info.installed) {
      status.textContent = `已安装：每个配置文件 ${info.expectedPerFile} 个事件，共 ${info.managed} 条。`;
    } else if (info.managed > 0) {
      status.textContent = `部分安装（${info.managed} 条），可能需要修复 —— 宠物程序换过路径时会出现这种情况。`;
    } else {
      status.textContent = "未安装。";
    }
    const problems = info.files.filter((f) => f.error).map((f) => `${f.path}：${f.error}`);
    detail.textContent = [
      `hook 命令指向 ${info.exe}`,
      ...info.files.map((f) => `${f.path} — 本宠物 ${f.managed} 条`),
      ...problems,
    ].join(" ｜ ");
  } catch (e) {
    status.textContent = `读取状态失败：${String(e)}`;
  }
}

async function runAgentAction(how: "install" | "uninstall"): Promise<void> {
  const command = how === "install" ? "agent_hooks_install" : "agent_hooks_uninstall";
  for (const id of ["agent-install", "agent-uninstall"]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = true;
  }
  const detail = agentDetail();
  try {
    const result = await invoke<{ files: AgentFileReport[] }>(command);
    if (detail) {
      detail.textContent = result.files
        .map((f) => `${f.path} — ${f.error ? `失败：${f.error}` : `${f.managed} 条`}`)
        .join(" ｜ ");
    }
  } catch (e) {
    if (detail) detail.textContent = `操作失败：${String(e)}`;
  } finally {
    for (const id of ["agent-install", "agent-uninstall"]) {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el) el.disabled = false;
    }
    await renderAgent();
  }
}

function wireAgentBox(): void {
  document.getElementById("agent-install")?.addEventListener("click", () => {
    void runAgentAction("install");
  });
  document.getElementById("agent-uninstall")?.addEventListener("click", () => {
    void runAgentAction("uninstall");
  });
  document.getElementById("agent-refresh")?.addEventListener("click", () => {
    void renderAgent();
  });
}

/* ---------- 桌宠形象（Petdex 图集） ---------- */

interface SkinInfo {
  slug: string;
  displayName: string;
  spriteVersionNumber: number;
  url: string;
}

const skinStatus = () => document.getElementById("skin-status");
const skinNameInput = () => document.getElementById("skin-name") as HTMLInputElement | null;
const skinInstallBtn = () => document.getElementById("skin-install") as HTMLButtonElement | null;

function setSkinStatus(text: string): void {
  const el = skinStatus();
  if (el) el.textContent = text;
}

function skinButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

/** 形象名与 displayName 都是外部数据：一律 textContent 建节点，不进 innerHTML */
function skinRow(skin: SkinInfo, current: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = `${skin.displayName}（${skin.slug} · 图集 v${skin.spriteVersionNumber}）${current ? " · 使用中" : ""}`;
  li.appendChild(label);
  if (!current) {
    li.appendChild(
      skinButton("使用", () => void runSkinCommand("pet_skin_use", skin.slug, `已切换到 ${skin.displayName}`)),
    );
  }
  li.appendChild(
    skinButton("删除", () => void runSkinCommand("pet_skin_remove", skin.slug, `已删除 ${skin.slug}`)),
  );
  return li;
}

async function renderSkins(): Promise<void> {
  const list = document.getElementById("skin-list");
  if (!list) return;
  try {
    const [items, active] = await Promise.all([
      invoke<SkinInfo[]>("pet_skin_list"),
      invoke<SkinInfo | null>("pet_skin_active"),
    ]);
    setSkinStatus(
      items.length === 0
        ? "还没有安装任何形象。输入名字点「安装」即可从 Petdex 画廊下载。"
        : `已安装 ${items.length} 个，当前使用：${active?.displayName ?? "（无）"}。`,
    );
    list.replaceChildren(...items.map((s) => skinRow(s, s.slug === active?.slug)));
  } catch (e) {
    setSkinStatus(`读取形象失败：${String(e)}`);
  }
}

/** 安装/切换/删除三个命令同形：install 收 name，其余收 slug */
async function runSkinCommand(
  command: "pet_skin_install" | "pet_skin_use" | "pet_skin_remove",
  arg: string,
  okText: string,
): Promise<void> {
  const btn = skinInstallBtn();
  if (btn) btn.disabled = true;
  try {
    await invoke(command, command === "pet_skin_install" ? { name: arg } : { slug: arg });
    setSkinStatus(`${okText}。`);
  } catch (e) {
    setSkinStatus(`操作失败：${String(e)}`);
  } finally {
    if (btn) btn.disabled = false;
    await renderSkins();
  }
}

function wireSkins(): void {
  const install = skinInstallBtn();
  const input = skinNameInput();
  install?.addEventListener("click", () => {
    const name = input?.value?.trim() ?? "";
    if (!name) {
      setSkinStatus("先输入一个 Petdex 名字，例如 deepseek。");
      return;
    }
    setSkinStatus(`正在从 Petdex 画廊下载 ${name}…`);
    void runSkinCommand("pet_skin_install", name, `已安装 ${name}`);
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") install?.click();
  });
  document.getElementById("skin-refresh")?.addEventListener("click", () => {
    void renderSkins();
  });
}

const GAME_MODE_KEY = "host:game-mode";

function wireGameMode(): void {
  const box = document.getElementById("game-mode-switch") as HTMLInputElement | null;
  if (!box) return;
  box.checked = localStorage.getItem(GAME_MODE_KEY) !== "0";
  box.addEventListener("change", async () => {
    const enabled = box.checked;
    localStorage.setItem(GAME_MODE_KEY, enabled ? "1" : "0");
    // 宠物窗据此启停传感并决定是否立刻恢复显示
    await emit("host:game-mode-changed", { enabled });
    void renderGameMode();
  });
}

async function renderGameMode(): Promise<void> {
  const el = document.getElementById("game-mode-status");
  if (!el) return;
  try {
    const watching = await invoke<boolean>("fullscreen_watch_status");
    el.textContent = watching
      ? "检测中：轮询一次前台窗口约 1.2 秒，代价可忽略。"
      : "已关闭：不再轮询前台窗口。";
  } catch (e) {
    el.textContent = `读取状态失败：${String(e)}`;
  }
}

async function main(): Promise<void> {
  await bus.init();
  await render();
  wireGameMode();
  void renderGameMode();
  wireAgentBox();
  void renderAgent();
  wireSkins();
  void renderSkins();

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

  // 首启自动装默认形象、或宠物窗那边换了形象 → 刷新形象列表
  await listen("pet:skin-changed", () => {
    void renderSkins();
  });

  // 其他窗口触发的启停（目前只有设置窗自己，保留下述同步逻辑以防扩展）
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", (e) => {
    const row = rows.get(e.payload.id);
    if (!row || e.payload.enabled) return;
    widgetHost.unmount(e.payload.id);
  });
}

void main();
