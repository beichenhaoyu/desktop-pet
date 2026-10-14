import { hostCall, hostErrorMessage } from "../../runtime/host-error";
import { $ } from "../dom";

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

export async function renderSkins(): Promise<void> {
  const list = $<HTMLUListElement>("skin-list");
  if (!list) return;
  try {
    const [items, active] = await Promise.all([
      hostCall<SkinInfo[]>("pet_skin_list"),
      hostCall<SkinInfo | null>("pet_skin_active"),
    ]);
    setSkinStatus(
      items.length === 0
        ? "还没有安装任何形象。输入名字点「安装」即可从 Petdex 画廊下载。"
        : `已安装 ${items.length} 个，当前使用：${active?.displayName ?? "（无）"}。`,
    );
    list.replaceChildren(...items.map((s) => skinRow(s, s.slug === active?.slug)));
  } catch (e) {
    setSkinStatus(`读取形象失败：${hostErrorMessage(e)}`);
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
    await hostCall(command, command === "pet_skin_install" ? { name: arg } : { slug: arg });
    setSkinStatus(`${okText}。`);
  } catch (e) {
    setSkinStatus(`操作失败：${hostErrorMessage(e)}`);
  } finally {
    if (install) install.disabled = false;
    await renderSkins();
  }
}

export function wireSkins(): void {
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
