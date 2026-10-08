// 权限同意框：展示插件身份与申请的能力，用户决定后回传宿主
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

interface ConsentDetails {
  req_id: string;
  plugin_id: string;
  plugin_name: string;
  caps: string[];
}

async function main(): Promise<void> {
  const reqId = getCurrentWindow().label.replace(/^consent-/, "");
  let details: ConsentDetails;
  try {
    details = await invoke<ConsentDetails>("consent_details", { reqId });
  } catch (err) {
    // 取不到详情（请求已被别处作废、窗口比请求活得久）时不能留一扇空白同意框：
    // 那意味着宿主那边还在等一个永远不会来的答复。按拒绝收场，让调用方立刻拿到结果。
    const box = document.getElementById("plugin-name");
    if (box) box.textContent = "这次授权请求已经失效";
    const list = document.getElementById("cap-list");
    if (list) {
      const li = document.createElement("li");
      li.textContent = String(err instanceof Error ? err.message : err);
      list.append(li);
    }
    void invoke("consent_answer", { reqId, granted: false }).finally(() => window.close());
    return;
  }

  document.getElementById("plugin-name")!.textContent =
    `${details.plugin_name}（${details.plugin_id}）`;
  const list = document.getElementById("cap-list")!;
  for (const cap of details.caps) {
    const li = document.createElement("li");
    li.textContent = cap;
    list.append(li);
  }

  const answer = (granted: boolean) => {
    void invoke("consent_answer", { reqId, granted }).finally(() => window.close());
  };
  document.getElementById("btn-allow")!.addEventListener("click", () => answer(true));
  document.getElementById("btn-deny")!.addEventListener("click", () => answer(false));
}

void main();
