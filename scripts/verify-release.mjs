// 打包版校验：CSP 是否真的强制、页面自身代码在 CSP 下能否经 petplugin 协议加载插件。
// 自己拉起/回收 release exe —— 单实例按 identifier 抢占，跑之前必须先停掉 dev 实例。
//   npm run verify:release              先 tauri build --no-bundle（约 3~4 分钟）
//   npm run verify:release -- --skip-build
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, env } from "node:process";

import { attach, createReport, hostInvoke, reloadAndWait, waitUntil } from "./cdp.mjs";
import { PROBE_ID, removeFixtures, writeFixtures } from "./fixtures.mjs";

const skipBuild = argv.includes("--skip-build");
const PORT = Number(env.CDP_PORT ?? 9224);
const EXE = resolve(import.meta.dirname, "../src-tauri/target/release/desktop-pet.exe");
const PLUGINS_DIR = join(dirname(EXE), "plugins");
const r = createReport("CSP 与插件加载（release）");

if (!skipBuild) {
  console.log("构建 release（tauri build --no-bundle）…");
  // 必须是这一整串：spawn 传数组会让第二个 `--` 原样落到 tauri，
  // 而 tauri 把它之后的参数转交给 cargo，cargo 不认 --no-bundle 直接失败。
  const build = spawn("npm run tauri build -- --no-bundle", { stdio: "inherit", shell: true });
  if ((await new Promise((res) => build.on("exit", res))) !== 0) {
    console.error("tauri build 失败");
    process.exit(2);
  }
}
if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`);
  process.exit(2);
}

mkdirSync(PLUGINS_DIR, { recursive: true });
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
});

let exitCode = 1;
try {
  writeFixtures(PLUGINS_DIR);
  const c = await attach(PORT, (t) => /tauri\.localhost\/$/.test(t.url), 90_000);
  try {
    r.info("已连接", c.url);
    const invoke = hostInvoke(c);

    r.group("CSP 是否随文档下发（Tauri 用响应头，不是 meta 标签）");
    const header = await c.ev(
      `(async () => { const res = await fetch('/index.html'); return res.headers.get('content-security-policy') ?? ''; })()`,
    );
    r.check("响应头含 CSP", true, header.includes("default-src 'none'"));
    r.check("script-src 不含 unsafe-inline", false, /script-src[^;]*unsafe-inline/.test(header));
    r.check("script-src 放行了插件协议", true, /script-src[^;]*petplugin\.localhost/.test(header));

    r.group("宿主自身在 CSP 下加载插件（真实启动路径，非 CDP 发起）");
    const prev = await c.ev(`localStorage.getItem('host:enabled-plugins') ?? '[]'`);
    await c.ev(`localStorage.setItem('host:enabled-plugins', JSON.stringify([${JSON.stringify(PROBE_ID)}]))`);
    await reloadAndWait(c);
    // 刚构建完的首次冷启动（杀软扫描 + WebView2 初始化）可能超过 20s，这里放宽
    const badgeSelector = `#widget-badge > div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
    const mounted = await waitUntil(c, `!!document.querySelector(${JSON.stringify(badgeSelector)})`, 60_000);
    if (!mounted) {
      console.log(
        "     现场: probes=" +
          (await c.ev(`(window.__probes ?? []).length`)) +
          " activated=" +
          (await c.ev(`window.__probeActivated ?? 'none'`)) +
          " 选择器再查=" +
          (await c.ev(`!!document.querySelector(${JSON.stringify(badgeSelector)})`)) +
          " 全部插槽=" +
          JSON.stringify(await c.ev(`[...document.querySelectorAll('div[data-plugin-id]')].map(d=>d.dataset.pluginId+':'+d.dataset.region)`)) +
          " badge容器=" +
          JSON.stringify(await c.ev(`document.getElementById('widget-badge')?.innerHTML?.slice(0,120) ?? '(无)'`)),
      );
    }
    r.check("探针 widget 挂载成功", true, mounted);
    const probe = await c.ev(`(window.__probes ?? [])[0] ?? null`);
    // 探针内的 eval 是页面代码发起的，才受 CSP 约束；CDP 直接求值不受约束，不能当判据
    r.check("探针内 eval 被拒（证明策略真的在强制）", "enforced", probe?.csp);
    r.check("widget 注入 <style> 被 style-src 放行", true, probe?.styleApplied);

    r.group("宿主侧规则在发布版同样有效");
    const undeclared = await invoke("permission_request", {
      pluginId: PROBE_ID,
      pluginName: "隔离探针",
      capabilities: ["ble:scan"],
    });
    r.check("未声明能力被拒", true, !undeclared.ok && /未在 manifest 声明/.test(String(undeclared.e)));
    const spoof = await invoke("consent_answer", { reqId: "rNOPE", granted: true });
    r.check("非同意框窗口不能应答授权", true, !spoof.ok && /does not own/.test(String(spoof.e)));

    r.group("无 CSP 违规");
    const violations = c.noise.filter((n) => n.startsWith("CSP:"));
    r.check("违规条数", 0, violations.length);
    c.noise.filter((n) => !n.startsWith("CSP:")).forEach((n) => console.log("   " + n));

    await c.ev(`localStorage.setItem('host:enabled-plugins', ${JSON.stringify(prev)})`);
  } finally {
    exitCode = r.summary() ? 1 : 0;
    c.close();
  }
} catch (err) {
  console.error("\n校验未启动:", String(err?.message ?? err).split("\n")[0]);
  console.error("若一直连不上 CDP：多半是 dev 实例还开着，单实例插件让 release 直接退出。");
} finally {
  app.kill();
  if (process.platform === "win32") spawn("taskkill", ["/IM", "desktop-pet.exe", "/F"], { stdio: "ignore", shell: true });
  removeFixtures(PLUGINS_DIR);
}

process.exit(exitCode);
