import { getEnabled, validateManifest } from "../runtime/plugin-runtime";
import { $, el } from "./dom";
import { navigate, manifests } from "./state";

/* ---------- 侧栏：宠物设置 + 每个插件一项 ---------- */

export function enabledSet(): Set<string> {
  return new Set(getEnabled());
}

export function renderNav(): void {
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
    item.addEventListener("click", () => void navigate(manifest.id));
    host.append(item);
  }

  const count = $<HTMLSpanElement>("nav-plugin-count");
  if (count) {
    // 只数「既装着又启用」的：启用清单里可能留着已被移走的插件 id（宿主不做垃圾回收）
    count.textContent = `${manifests.filter((m) => on.has(m.id)).length}/${manifests.length}`;
  }
}

export function applyFilter(): void {
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
