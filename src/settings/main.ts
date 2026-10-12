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

/** 宠物设置 = 非插件功能的全部配置项；插件页 = 宿主给壳，内容交给插件的 widget */
const PET_VIEW = "pet";

let banner: HTMLElement | null = null;
let manifests: PluginManifest[] = [];
let selected = PET_VIEW;
/** 当前挂在插件页里的 widget 属于哪个插件（切插件时要先收掉上一个） */
let mountedFor: string | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/* ---------- 侧栏：宠物设置 + 每个插件一项 ---------- */

function enabledSet(): Set<string> {
  return new Set(getEnabled());
}

function renderNav(): void {
  const host = $<HTMLDivElement>("nav-plugins");
  if (!host) return;
  const on = enabledSet();
  host.replaceChildren();

  for (const manifest of manifests) {
    const invalid = validateManifest(manifest);
    const item = el("button", undefined, "nav-item plugin");
    item.type = "button";
    item.dataset.view = manifest.id;
    item.dataset.search = invalid
      ? manifest.id.toLowerCase()
      : `${manifest.name} ${manifest.id} ${(manifest.permissions ?? []).join(" ")}`.toLowerCase();

    const dot = el("span", undefined, "nav-dot" + (on.has(manifest.id) ? " on" : ""));
    dot.title = on.has(manifest.id) ? "已启用" : "已停用";
    const label = el("span", invalid ? `${manifest.id}（无效）` : manifest.name, "nav-label");
    item.append(dot, label);
    item.addEventListener("click", () => void select(manifest.id));
    host.append(item);
  }

  const count = $<HTMLSpanElement>("nav-plugin-count");
  if (count) {
    // 只数「既装着又启用」的：启用清单是 localStorage 里的历史值，插件被移走后还留着
    count.textContent = `${manifests.filter((m) => on.has(m.id)).length}/${manifests.length}`;
  }
}

function applyFilter(): void {
  const input = $<HTMLInputElement>("search");
  const needle = (input?.value ?? "").trim().toLowerCase();
  let shown = 0;
  for (const item of document.querySelectorAll<HTMLElement>("#nav-plugins .nav-item")) {
    const hit = !needle || (item.dataset.search ?? "").includes(needle);
    item.style.display = hit ? "" : "none";
    if (hit) shown += 1;
  }
  const empty = $<HTMLElement>("plugin-empty");
  if (empty) empty.hidden = shown > 0;
}

/* ---------- 视图切换 ---------- */

function titles(): { title: string; hint: string } {
  if (selected === PET_VIEW) {
    return {
      title: "宠物设置",
      hint: "宠物本体与宿主页面的配置；插件的功能与页面在左边插件区",
    };
  }
  const m = manifests.find((x) => x.id === selected);
  return {
    title: m && !validateManifest(m) ? m.name : "插件",
    hint: "启停即时生效；未授权能力首次调用时会弹出确认框",
  };
}

async function select(view: string): Promise<void> {
  selected = view;
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", (item as HTMLElement).dataset.view === view);
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== (view === PET_VIEW ? "pet" : "plugin");
  }
  const t = titles();
  const title = $<HTMLHeadingElement>("view-title");
  const hint = $<HTMLParagraphElement>("view-hint");
  if (title) title.textContent = t.title;
  if (hint) hint.textContent = t.hint;

  if (view === PET_VIEW) {
    await detachWidget();
    return;
  }
  await renderPluginPage();
}

/* ---------- 插件页：壳由宿主给，中间那块由插件自己渲染 ---------- */

async function detachWidget(): Promise<void> {
  if (!mountedFor) return;
  const id = mountedFor;
  mountedFor = null;
  await widgetHost.unmount(id);
  const box = $<HTMLDivElement>("plugin-settings");
  box?.replaceChildren();
}

async function renderPluginPage(): Promise<void> {
  const manifest = manifests.find((m) => m.id === selected);
  const icon = $<HTMLDivElement>("plugin-icon");
  const name = $<HTMLSpanElement>("plugin-name");
  const version = $<HTMLSpanElement>("plugin-version");
  const idLine = $<HTMLDivElement>("plugin-id");
  const desc = $<HTMLDivElement>("plugin-desc");
  const perms = $<HTMLDivElement>("plugin-perms");
  const toggle = $<HTMLInputElement>("plugin-toggle");
  const toggleLabel = $<HTMLSpanElement>("plugin-toggle-label");
  const note = $<HTMLParagraphElement>("plugin-note");
  const box = $<HTMLDivElement>("plugin-settings");
  if (!manifest || !icon || !name || !version || !idLine || !desc || !perms || !toggle || !box) return;

  const invalid = validateManifest(manifest);
  icon.textContent = (manifest.name || manifest.id).trim().slice(0, 1).toUpperCase();
  name.textContent = invalid ? manifest.id : manifest.name;
  version.textContent = invalid ? "" : `v${manifest.version}`;
  idLine.textContent = manifest.id;
  desc.textContent = invalid ? "" : (manifest.description ?? "");

  perms.replaceChildren();
  if (invalid) {
    perms.append(el("span", `manifest 无效：${invalid}`, "perm-chip warn"));
  } else {
    for (const p of manifest.permissions ?? []) {
      // 能出网、能落盘的权限标出来，让人一眼看到风险面
      perms.append(el("span", p, "perm-chip" + (p === "http" || p === "storage" ? " warn" : "")));
    }
    if ((manifest.permissions ?? []).length > 0) {
      const revoke = el("button", "撤销授权", "btn-revoke");
      revoke.type = "button";
      revoke.addEventListener("click", () => {
        // 撤销前的宿主确认条（CONTEXT.md「生命周期」）：默认连带卸载 hook，可以只撤能力。
        // 卸载复用 agent_hooks_uninstall 的宿主路径（不带 pluginId）——撤销入口在宿主壳里，
        // 不能指望插件还活着来收自己的 hook。
        const strip = el("div", undefined, "revoke-confirm");
        strip.id = "revoke-confirm";
        const line = el("label", undefined, "row-line");
        const alsoUninstall = document.createElement("input");
        alsoUninstall.type = "checkbox";
        alsoUninstall.id = "revoke-uninstall";
        alsoUninstall.checked = true;
        line.append(alsoUninstall, document.createTextNode("同时卸载 Agent hook"));
        const go = el("button", "确认撤销");
        go.type = "button";
        go.id = "revoke-go";
        const cancel = el("button", "取消");
        cancel.type = "button";
        cancel.id = "revoke-cancel";
        cancel.addEventListener("click", () => strip.remove());
        go.addEventListener("click", async () => {
          go.disabled = true;
          if (alsoUninstall.checked) {
            try {
              await invoke("agent_hooks_uninstall");
            } catch (err) {
              // 卸载失败不拦住撤权：能力先收回，失败原因留给宿主日志
              console.error("[settings] 撤销时卸载 hook 失败", err);
            }
          }
          try {
            await invoke("permission_revoke", { pluginId: manifest.id });
            revoke.textContent = alsoUninstall.checked ? "已撤销（含卸载 hook）" : "已撤销（仅能力）";
            revoke.disabled = true;
          } catch (err) {
            // 撤销现在是宿主端会失败的命令（门禁、非法 id），不能装成成功
            revoke.textContent = `撤销失败：${String(err instanceof Error ? err.message : err)}`;
            go.disabled = false;
          }
          strip.remove();
        });
        strip.append(line, go, cancel);
        revoke.after(strip);
      });
      perms.append(revoke);
    }
  }

  const on = enabledSet().has(manifest.id);
  toggle.checked = on;
  toggle.disabled = !!invalid;
  if (toggleLabel) toggleLabel.textContent = on ? "已启用" : "已停用";

  if (note) note.hidden = true;
  if (invalid) {
    await detachWidget();
    if (note) {
      note.textContent = "这个插件的 manifest 有问题，未加载。修好后放回插件目录即可。";
      note.hidden = false;
    }
    return;
  }

  // 内容由插件提供：它自己的 widget.js 挂在 settings 区的独立 Shadow DOM 里
  if (!on) {
    await detachWidget();
    if (note) {
      note.textContent = "启用后这里才显示插件自己的页面。";
      note.hidden = false;
    }
    return;
  }
  if (!manifest.widget) {
    await detachWidget();
    if (note) {
      note.textContent = "这个插件没有提供设置页面。";
      note.hidden = false;
    }
    return;
  }
  if (mountedFor !== manifest.id) {
    await detachWidget();
    mountedFor = manifest.id;
    try {
      await widgetHost.mount(manifest, "settings", box);
    } catch (e) {
      mountedFor = null;
      console.error(`[settings] mount widget: ${manifest.id}`, e);
      if (note) {
        note.textContent = `插件页面加载失败：${String(e instanceof Error ? e.message : e)}`;
        note.hidden = false;
      }
      return;
    }
  }
}

toggleListener();
function toggleListener(): void {
  const toggle = $<HTMLInputElement>("plugin-toggle");
  toggle?.addEventListener("change", async () => {
    const manifest = manifests.find((m) => m.id === selected);
    if (!manifest) return;
    const on = toggle.checked === true;
    const ids = new Set(getEnabled());
    if (on) ids.add(manifest.id);
    else ids.delete(manifest.id);
    setEnabledIds([...ids]);
    const label = $<HTMLSpanElement>("plugin-toggle-label");
    if (label) label.textContent = on ? "已启用" : "已停用";
    renderNav();
    applyFilter();
    await renderPluginPage();
    // 通知宠物窗运行时启停（overlay/settings 窗各自监听同一事件挂载 widget）
    await emit("host:plugin-toggled", { id: manifest.id, enabled: on });
  });
}

async function render(): Promise<void> {
  const list = await invoke<PluginManifest[]>("plugins_list");
  // 目录可能已经变了：先按新的清单重建侧栏，再决定当前页怎么渲染
  manifests = [...list].sort((a, b) => a.id.localeCompare(b.id));
  const alive = new Set(manifests.map((m) => m.id));
  if (selected !== PET_VIEW && !alive.has(selected)) {
    // 正在看的插件被移走了，回到宠物设置，别留一张空壳
    mountedFor = null;
    await widgetHost.unmount(selected).catch(() => undefined);
    selected = PET_VIEW;
  }
  renderNav();
  await select(selected);
}

function wireNav(): void {
  const pet = document.querySelector<HTMLElement>('.nav-item[data-view="pet"]');
  pet?.addEventListener("click", () => void select(PET_VIEW));
  $<HTMLInputElement>("search")?.addEventListener("input", applyFilter);
}

/* ---------- 快捷键 ---------- */

const hotkeyStatus = () => $<HTMLElement>("hotkey-status");

async function renderHotkey(): Promise<void> {
  const el2 = hotkeyStatus();
  if (!el2) return;
  try {
    const info = await invoke<{ accelerator: string; default: string }>("hotkey_status");
    el2.replaceChildren(
      document.createTextNode("当前："),
      Object.assign(document.createElement("kbd"), { textContent: info.accelerator }),
      document.createTextNode(info.accelerator === info.default ? "（默认）" : ""),
    );
    const input = $<HTMLInputElement>("hotkey-input");
    if (input && !input.value) input.value = info.accelerator;
  } catch (e) {
    el2.textContent = `读取失败：${String(e)}`;
  }
}

async function saveHotkey(accelerator: string): Promise<void> {
  const el2 = hotkeyStatus();
  try {
    const saved = await invoke<string>("hotkey_set", { accelerator });
    const input = $<HTMLInputElement>("hotkey-input");
    if (input) input.value = saved;
    await renderHotkey();
    el2?.classList.remove("error");
  } catch (e) {
    if (el2) el2.textContent = `应用失败：${String(e)}`;
  }
}

function wireHotkey(): void {
  $<HTMLElement>("hotkey-save")?.addEventListener("click", () => {
    const value = ($<HTMLInputElement>("hotkey-input")?.value ?? "").trim();
    if (!value) {
      const el2 = hotkeyStatus();
      if (el2) el2.textContent = "先输入一个组合键，例如 Ctrl+Alt+P。";
      return;
    }
    void saveHotkey(value);
  });
  $<HTMLElement>("hotkey-reset")?.addEventListener("click", () => {
    void saveHotkey("CommandOrControl+Alt+P");
  });
  $<HTMLElement>("hotkey-test")?.addEventListener("click", async () => {
    const el2 = hotkeyStatus();
    const value = ($<HTMLInputElement>("hotkey-input")?.value ?? "").trim();
    if (!value || !el2) return;
    try {
      const free = await invoke<boolean>("hotkey_test", { accelerator: value });
      el2.textContent = free
        ? `「${value}」可以注册，没被别的应用占用。`
        : `「${value}」注册失败，多半已被其他程序占用，换一个吧。`;
    } catch (e) {
      el2.textContent = `测试失败：${String(e)}`;
    }
  });
}

/* ---------- 开机自启 ---------- */

async function renderAutostart(): Promise<void> {
  const box = $<HTMLInputElement>("autostart-switch");
  const el2 = $<HTMLElement>("autostart-status");
  if (!box || !el2) return;
  try {
    const info = await invoke<{ enabled: boolean; exe: string; devBuild: boolean }>("autostart_status");
    box.checked = info.enabled;
    el2.textContent = info.devBuild
      ? `当前跑的是开发构建，注册的是 ${info.exe} —— 换正式包后请重新打开一次这个开关。`
      : `启动项指向 ${info.exe}`;
  } catch (e) {
    el2.textContent = `读取失败：${String(e)}`;
  }
}

function wireStartup(): void {
  const box = $<HTMLInputElement>("autostart-switch");
  box?.addEventListener("change", async () => {
    const el2 = $<HTMLElement>("autostart-status");
    const want = box.checked;
    try {
      const now = await invoke<boolean>("autostart_set", { enabled: want });
      box.checked = now;
      if (el2) el2.textContent = now ? "已加入登录启动项。" : "已移除登录启动项。";
    } catch (e) {
      box.checked = !want;
      if (el2) el2.textContent = `改动失败：${String(e)}`;
    }
  });
}

/* ---------- 桌宠形象（Petdex 图集） ---------- */

interface SkinInfo {
  slug: string;
  displayName: string;
  spriteVersionNumber: number;
  url: string;
}

const skinStatus = () => $<HTMLElement>("skin-status");

function setSkinStatus(text: string): void {
  const el2 = skinStatus();
  if (el2) el2.textContent = text;
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
  if (current) li.className = "current";
  const label = document.createElement("span");
  label.textContent = `${skin.displayName}（${skin.slug} · 图集 v${skin.spriteVersionNumber}）`;
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
  const list = $<HTMLUListElement>("skin-list");
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
  const install = $<HTMLButtonElement>("skin-install");
  if (install) install.disabled = true;
  try {
    await invoke(command, command === "pet_skin_install" ? { name: arg } : { slug: arg });
    setSkinStatus(`${okText}。`);
  } catch (e) {
    setSkinStatus(`操作失败：${String(e)}`);
  } finally {
    if (install) install.disabled = false;
    await renderSkins();
  }
}

function wireSkins(): void {
  const install = $<HTMLButtonElement>("skin-install");
  const input = $<HTMLInputElement>("skin-name");
  install?.addEventListener("click", () => {
    const name = (input?.value ?? "").trim();
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
  $<HTMLElement>("skin-refresh")?.addEventListener("click", () => void renderSkins());
}

/* ---------- 游戏模式 ---------- */

const GAME_MODE_KEY = "host:game-mode";

function wireGameMode(): void {
  const box = $<HTMLInputElement>("game-mode-switch");
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
  const el2 = $<HTMLElement>("game-mode-status");
  if (!el2) return;
  try {
    const watching = await invoke<boolean>("fullscreen_watch_status");
    el2.textContent = watching
      ? "检测中：轮询一次前台窗口约 1.2 秒，代价可忽略。"
      : "已关闭：不再轮询前台窗口。";
  } catch (e) {
    el2.textContent = `读取状态失败：${String(e)}`;
  }
}

/* ---------- 启动 ---------- */

async function main(): Promise<void> {
  await bus.init();
  wireNav();
  toggleListener();
  await render();
  wireGameMode();
  void renderGameMode();
  wireSkins();
  void renderSkins();
  wireHotkey();
  void renderHotkey();
  wireStartup();
  void renderAutostart();

  // 宠物窗运行时上报的插件异常 → 顶部红条
  banner = el("div", "", "error-banner");
  banner.style.display = "none";
  $<HTMLElement>("content")?.prepend(banner);
  await listen<{ plugin: string; error: string }>("host:plugin-error", (e) => {
    if (!banner) return;
    banner.textContent = `插件异常已隔离 — ${e.payload.plugin}: ${e.payload.error}`;
    banner.style.display = "";
  });

  // 插件目录变动 → 侧栏立刻跟着增删
  await listen("host:plugins-changed", () => {
    void render().catch((e) => console.error("[settings] render", e));
  });

  // 首启自动装默认形象、或宠物窗那边换了形象 → 刷新形象列表
  await listen("pet:skin-changed", () => void renderSkins());

  // 其他窗口触发的启停：同步侧栏那个点与当前插件页
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", (e) => {
    renderNav();
    applyFilter();
    if (e.payload.id === selected) void renderPluginPage();
    if (!e.payload.enabled && mountedFor === e.payload.id) void detachWidget();
  });
}

void main();
