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
  const details = await invoke<ConsentDetails>("consent_details", { reqId });

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
