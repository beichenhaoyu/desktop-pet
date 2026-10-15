// 等 CDP 上出现宠物页 —— dev 实例的「起来了」判据（清单 A3 的 CI 步骤用，手工起实例时同样能用）。
//
// 为什么不是把套件里 attach 的超时调大就算：attach 那 90 秒里可能连 cargo 编译都还没跑完，
// 那种红看起来像「webview 起不来」，其实根本没轮到它。等待要有自己可命名的边界，
// 超时了要说清是「没等到宠物页」而不是「套件挂了」。
//
// 用法：node tools/wait-cdp.mjs [--port=9223] [--timeout=600]
// 就绪 → 打一行 READY 并退 0；超时 → 打 TIMEOUT 与当前看到的页面 URL，退 1。
import { argv, exit } from "node:process";

import { listPages } from "../tests/e2e/harness/cdp.mjs";

const arg = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const port = Number(arg("port", "9223"));
const deadline = Date.now() + Number(arg("timeout", "600")) * 1000;
// 与 verify-isolation.mjs 的 isPetPage 同一形状（dev 走 localhost:1420，打包版走 tauri.localhost）
const PET = /localhost:1420\/(src\/)?index\.html$/;

let seen = [];
while (Date.now() < deadline) {
  seen = await listPages(port).catch(() => []);
  const pet = seen.find((t) => PET.test(t.url));
  if (pet) {
    console.log(`READY port=${port} pages=${seen.length} pet=${pet.url}`);
    exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`TIMEOUT port=${port} 没等到宠物页；当前看到 ${seen.length} 个 target：`);
for (const t of seen) console.log(`  - ${t.type} ${t.url}`);
exit(1);
