// 游戏模式端到端断言：用一个真的全屏窗口当触发源，验证宠物会隐身、安静下来、
// 事件通路照常在跑，并在退出全屏后恢复。
//   终端 1: npm run dev:debug      终端 2: npm run verify:game
// 注意：测试期间屏幕上会短暂出现一个铺满主显示器的黑色窗口（每次约 10 秒，自行关闭）。
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const GAME_KEY = "host:game-mode";
const INBOX = `${env.APPDATA}\\com.desktoppet.pet\\agent\\inbox`;
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("游戏模式（dev）");

const psScript = (sec) => `
$sig = @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
Add-Type -MemberDefinition $sig -Name U32 -Namespace W | Out-Null
# 不设成 DPI aware 的话 PowerShell 拿到的是虚拟化坐标，和 Win32 侧的物理像素对不上
[W.U32]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.BackColor = [System.Drawing.Color]::Black
$f.Text = 'pet-verify-fullscreen'
$f.Bounds = $b
[void]$f.Show()
$deadline = (Get-Date).AddSeconds(${sec})
# 必须一边泵消息一边抢前台：只 Start-Sleep 的话激活事件不会被处理，
# 窗口虽然铺满屏幕却永远不是前台窗口，检测器（读 GetForegroundWindow）看不到它
while ((Get-Date) -lt $deadline) {
  [void][W.U32]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
  [void][W.U32]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
  [void][W.U32]::BringWindowToTop($f.Handle)
  [void][W.U32]::SetForegroundWindow($f.Handle)
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 150
}
$f.Close()
`;

/** 起一个铺满主显示器的无边框窗口，sec 秒后自行关闭 */
function coverScreen(sec) {
  const child = spawn("powershell", ["-NoProfile", "-STA", "-Command", psScript(sec)], {
    stdio: "ignore",
  });
  child.on("error", (e) => console.log(`  · powershell 启动失败：${e.message}`));
  return child;
}

let c = null;
try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
  c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(c);
  const token = `game-${Date.now()}`;
  await c.ev(`window.__verifyToken = ${JSON.stringify(token)}; true`);
  const origGameMode = await c.ev(`localStorage.getItem(${JSON.stringify(GAME_KEY)}) ?? '1'`);

  // 「还在忙」的观测点用 requestAnimationFrame：主循环每帧都会再调一次全局 rAF，
  // 所以运行中替换全局函数就能数到真实帧数。
  // （不要用替换 __TAURI_INTERNALS__.invoke 的法子：@tauri-apps/api 在 import 时
  //  就把 invoke 绑成模块内引用了，事后替换数到的是 0，会让人误判「轮询停了」）
  r.check(
    "已挂上帧计数",
    true,
    await c.ev(`(() => {
      window.__raf = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => { window.__raf += 1; return cb(t); });
      return true;
    })()`),
  );
  const resetRaf = () => c.ev(`window.__raf = 0; true`);
  const rafCount = () => c.ev(`window.__raf`);
  const docHidden = () => c.ev(`document.hidden === true`);
  /**
   * 窗口可见性只能问宿主：窗口被 hide 之后 WebView2 仍把页面标成可见，
   * 用 document.hidden 判隐藏会得到「一直没隐藏」的假结论。
   */
  async function waitPetVisible(want, timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await invoke("plugin:window|is_visible", { label: "pet" });
      if (v.ok && v.v === want) return true;
      await sleep(500);
    }
    return false;
  }

  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    window.__topics = [];
    bus.subscribe('agent:state', (p) => window.__topics.push(p));
    return true;
  })()`);

  async function reportProbe(tag) {
    const snap = await invoke("fullscreen_probe");
    if (snap.ok) {
      const v = snap.v;
      r.info(
        `${tag} 检测器所见`,
        `前台「${v.foreground || "?"}」 rect=${JSON.stringify(v.fg_rect)} 显示器=${JSON.stringify(v.monitor)} 标题栏=${v.has_caption} 自己=${v.same_process} 结论=${v.active}`,
      );
    } else {
      r.info(`${tag} 检测器所见`, `读取失败：${snap.e}`);
    }
    return snap.ok ? snap.v : null;
  }

  r.group("前置");
  // 清场：上一轮可能留下同名会话仍是 running，那样本轮「写一条让它变 running」就看不到状态变化
  appendFileSync(
    `${INBOX}\\session-end.jsonl`,
    JSON.stringify({ phase: "session-end", at: Date.now(), payload: { session_id: "game-mode-hidden" } }) + "\n",
  );
  await sleep(2000);
  const status = await invoke("fullscreen_watch_status");
  r.check("宿主在检测前台全屏（默认开）", true, status.ok && status.v === true);
  await resetRaf();
  await sleep(1000);
  const visibleFrames = await rafCount();
  r.check("可见时动画在跑（1 秒内有帧）", true, visibleFrames > 10);
  await reportProbe("基线");

  r.group("全屏出现 → 隐身并安静");
  const cover1 = coverScreen(16);
  // 先等检测器给出结论，再断言隐身：两步分开才知道是「没检测到」还是「检测到没执行」
  let snap = null;
  for (let i = 0; i < 12 && !(snap && snap.active); i++) {
    await sleep(1000);
    snap = await reportProbe("全屏中");
  }
  r.check("检测器判定为全屏", true, !!snap && snap.active === true);
  r.check("宠物窗被隐藏", true, await waitPetVisible(false, 15_000));
  r.info("document.hidden（不可信，仅作记录）", String(await docHidden()));
  await resetRaf();
  await sleep(1500);
  r.check("隐藏后动画停止", 0, await rafCount());

  r.group("隐身不影响事件通路");
  appendFileSync(
    `${INBOX}\\user-prompt.jsonl`,
    JSON.stringify({ phase: "user-prompt", at: Date.now(), payload: { session_id: "game-mode-hidden" } }) + "\n",
  );
  r.check(
    "隐藏时宿主事件仍能进总线",
    true,
    await waitUntil(c, `(window.__topics.slice().some(p => p.state === 'running'))`, 12_000),
  );

  r.group("全屏结束 → 恢复显示与动画");
  cover1.kill();
  r.check("宠物窗重新可见", true, await waitPetVisible(true, 15_000));
  await resetRaf();
  await sleep(1000);
  r.check("恢复后动画重新跑起来", true, (await rafCount()) > 10);

  r.group("关掉开关就不再隐身");
  await c.ev(`localStorage.setItem(${JSON.stringify(GAME_KEY)}, '0'); true`);
  const off = await invoke("fullscreen_watch_set", { enabled: false });
  r.check("传感已停止", true, off.ok && off.v === false);
  const cover2 = coverScreen(10);
  await sleep(5000); // 给检测足够时间：还会隐身的话这会儿已经隐了
  await reportProbe("开关关闭时");
  r.check("开关关着时全屏不影响显示", true, await waitPetVisible(true, 4_000));
  await c.ev(`localStorage.setItem(${JSON.stringify(GAME_KEY)}, ${JSON.stringify(origGameMode)}); true`);
  const on = await invoke("fullscreen_watch_set", { enabled: true });
  r.check("传感已恢复", true, on.ok && on.v === true);
  cover2.kill();

  r.group("收尾");
  r.check("宠物窗最终可见", true, await waitPetVisible(true, 15_000));
  r.check("测试期间宠物窗未被重载", token, await c.ev(`window.__verifyToken ?? null`));
  await sleep(500);
  r.check("零噪音", [], c.noise);
} finally {
  // 本跑自己留下的会话必须收掉：否则它以 running 挂 90 秒，
  // 下一轮 verify:agent 的起点状态就是 running，「第一次事件应当变 running」会整组假失败
  try {
    appendFileSync(
      `${INBOX}\\session-end.jsonl`,
      JSON.stringify({ phase: "session-end", at: Date.now(), payload: { session_id: "game-mode-hidden" } }) + "\n",
    );
  } catch {
    /* 目录不在就是宿主没起来，无所谓 */
  }
  if (c) {
    await hostInvoke(c)("fullscreen_watch_set", { enabled: true }).catch(() => undefined);
    await reloadAndWait(c).catch(() => undefined); // 换新文档，别把本跑的输出留给下一次 attach
    await sleep(1200);
  }
  const failed = r.summary();
  c?.close();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
