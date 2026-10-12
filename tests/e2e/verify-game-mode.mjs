// 游戏模式端到端断言：用一个真的全屏窗口当触发源，验证宠物会隐身、安静下来、
// 事件通路照常在跑，并在退出全屏后恢复。
//   终端 1: npm run dev:debug      终端 2: npm run verify:game
// 注意：测试期间屏幕上会短暂出现一个铺满主显示器的深灰窗口（非置顶、任务栏里能看到，
// 每次约 10~16 秒后自动关闭；抢前台期间别的置顶程序可能短暂闪动）。
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, reloadAndWait, waitForPage, waitUntil } from "./cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const GAME_KEY = "host:game-mode";
// 没有 APPDATA 的话这里会拼出 `undefined\com...`，脚本就在一个不存在的路径上跑断言：
// 那种失败和被测行为的失败长得一模一样，必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：找不到宿主收件目录，拒绝开跑。");
  process.exit(2);
}
const INBOX = `${env.APPDATA}\\com.desktoppet.pet\\agent\\inbox`;
const isPetPage = (t) => /localhost:1420\/(index\.html)?$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("游戏模式（dev）");

// 触发源窗口。写法上有几条硬规矩，起因是 2026-09-30 这脚本把用户的会话压垮过一次
// （全屏 + TopMost + 每 150ms 注入 ALT 抢前台，父进程被 timeout 杀掉后留下孤儿窗口）：
//   · 不 TopMost、任务栏可见：万一没关掉，用户还能从任务栏右键结束它
//   · 不用纯黑：至少看得出是一扇窗而不是黑屏
//   · 不注入键盘事件，改用 SwitchToThisWindow 抢前台
//   · 每轮检查父进程是否还活着：脚本被杀就立刻收窗，绝不留孤儿
const psScript = (sec, parentPid) => `
$sig = @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool fAltTab);
'@
Add-Type -MemberDefinition $sig -Name U32 -Namespace W | Out-Null
# 不设成 DPI aware 的话 PowerShell 拿到的是虚拟化坐标，和 Win32 侧的物理像素对不上
[W.U32]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.TopMost = $false
$f.ShowInTaskbar = $true
$f.BackColor = [System.Drawing.Color]::FromArgb(38, 42, 50)
$f.Text = 'pet-verify-fullscreen'
$f.Bounds = $b
[void]$f.Show()
$deadline = (Get-Date).AddSeconds(${sec})
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { break }
  [void][W.U32]::SwitchToThisWindow($f.Handle, $true)
  [void][W.U32]::SetForegroundWindow($f.Handle)
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 400
}
$f.Close()
`;

/** 本跑起过的触发窗，收尾时按 PID 精确收掉（杀 powershell 即连带销毁它的窗口） */
const covers = new Set();

function coverScreen(sec) {
  const child = spawn(
    "powershell",
    ["-NoProfile", "-STA", "-Command", psScript(sec, process.pid)],
    { stdio: "ignore" },
  );
  covers.add(child);
  child.on("exit", () => covers.delete(child));
  child.on("error", (e) => console.log(`  · powershell 启动失败：${e.message}`));
  return child;
}

function killCovers() {
  for (const child of covers) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退了 */
    }
  }
  covers.clear();
}

// 被 SIGTERM/SIGINT 打断时也必须先收窗：上一轮就是死在「脚本被杀、窗口留在屏幕上」
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killCovers();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
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
  // 装了 hook 之后这台机器是活的：跑断言的 agent 自己每次工具调用都在写 pre/post，
  // 宿主总状态会一直停在 running。不清干净的话「写一条事件应当让状态翻转」必然假失败。
  for (const phase of ["user-prompt", "pre", "post", "stop", "approval-request"]) {
    let text = "";
    try {
      text = readFileSync(`${INBOX}\\${phase}.jsonl`, "utf8");
    } catch (err) {
      // 文件还没被写过是正常情况；其余错误（权限、路径）要说出来，
      // 否则「清场没做成」和「这台机器根本没有事件」看起来一模一样
      if (err?.code !== "ENOENT") console.log(`  · 清场时读不到 ${phase}.jsonl：${String(err?.message ?? err).slice(0, 80)}`);
      continue;
    }
    for (const id of new Set([...text.matchAll(/"session_id":"([^"]+)"/g)].map((m) => m[1]))) {
      appendFileSync(
        `${INBOX}\\session-end.jsonl`,
        JSON.stringify({ phase: "session-end", at: Date.now(), payload: { session_id: id } }) + "\n",
      );
    }
  }
  await sleep(2500);
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
  // 探针用 needs_input 而不是 running：这台机器的 hook 是活的，总状态可能已经是
  // running，那就看不到变化；needs_input 在汇总里压过 running，一定是次变化。
  appendFileSync(
    `${INBOX}\\approval-request.jsonl`,
    JSON.stringify({ phase: "approval-request", at: Date.now(), payload: { session_id: "game-mode-hidden" } }) + "\n",
  );
  r.check(
    "隐藏时宿主事件仍能进总线",
    true,
    await waitUntil(c, `(window.__topics.slice().some(p => p.state === 'needs_input'))`, 12_000),
  );
  appendFileSync(
    `${INBOX}\\session-end.jsonl`,
    JSON.stringify({ phase: "session-end", at: Date.now(), payload: { session_id: "game-mode-hidden" } }) + "\n",
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
} catch (err) {
  // 断言中途抛错绝不能以 0 收场：对回归工具来说，「崩了但退出码 0」比一条红断言危险得多
  r.check("脚本未抛异常", true, false);
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  // 先收掉自己起的触发窗，再管别的：屏幕上有扇铺满的窗挂着是最不能留给用户的状态
  killCovers();
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
