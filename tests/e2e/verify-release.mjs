// 打包版校验：CSP 是否真的强制、页面自身代码在 CSP 下能否经 petplugin 协议加载插件。
// 自己拉起/回收 release exe —— 单实例按 identifier 抢占，跑之前必须先停掉 dev 实例。
//   npm run verify:release              先 tauri build --no-bundle（约 3~4 分钟）
//   npm run verify:release -- --skip-build
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, env } from "node:process";

import { attach, createReport, hostInvoke, listPages, openSettingsInvoker, readEnabledIds, reloadAndWait, waitUntil, writeEnabledIds } from "./harness/cdp.mjs";
import { PROBE_ID, removeFixtures, writeFixtures } from "./harness/fixtures.mjs";

const skipBuild = argv.includes("--skip-build");
const PORT = Number(env.CDP_PORT ?? 9224);
const EXE = resolve(import.meta.dirname, "../../src-tauri/target/release/desktop-pet.exe");
const PLUGINS_DIR = join(dirname(EXE), "plugins");
/** L1 原型（ADR-0006）的取证插件：仓库里那份夹具装进打包版的插件目录，跑完删 */
const L1_ID = "zz.l1-probe";
const L1_FIXTURE = resolve(import.meta.dirname, "../fixtures/l1-probe");
const L1_DIR = join(PLUGINS_DIR, L1_ID);
const L1_FLAG = "host:worker-plugin-host";
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
  const c = await attach(PORT, (t) => /tauri\.localhost\/src\/index\.html$/.test(t.url), 90_000);
  try {
    r.info("已连接", c.url);
    const invoke = hostInvoke(c);

    r.group("CSP 是否随文档下发（Tauri 用响应头，不是 meta 标签）");
    const header = await c.ev(
      `(async () => { const res = await fetch('/src/index.html'); return res.headers.get('content-security-policy') ?? ''; })()`,
    );
    r.check("响应头含 CSP", true, header.includes("default-src 'none'"));
    r.check("script-src 不含 unsafe-inline", false, /script-src[^;]*unsafe-inline/.test(header));
    r.check("script-src 放行了插件协议", true, /script-src[^;]*petplugin\.localhost/.test(header));

    r.group("桌宠图集在打包版 CSP 下真的能解码（dev 不注入 CSP，这条只能在 release 验）");
    const skin = await invoke("pet_skin_active");
    const skinList = await invoke("pet_skin_list");
    // 原来这条钉的是「激活的必须是 deepseek」——那是「用户从没换过形象」的隐含前提，
    // 换过一次皮肤就常年红。真正要验的是随包那份形象装上了、且当前激活的那张图能被 CSP 解码（下一条）。
    r.check(
      "随包的默认形象 deepseek 在列表里",
      true,
      (skinList.v ?? []).some((s) => s.slug === "deepseek"),
    );
    r.check("img-src 放行 petskin 协议", true, /img-src[^;]*petskin\.localhost/.test(header));
    // 由页面自己发起的 <img> 加载才受 img-src 约束；被 CSP 拦下会走 onerror
    const decoded = await c.ev(`(async () => {
      const url = ${JSON.stringify(skin.v?.url ?? "")};
      if (!url) return "no-skin";
      return await new Promise((res) => {
        const img = new Image();
        const timer = setTimeout(() => res("timeout"), 20_000);
        img.onload = () => { clearTimeout(timer); res(img.naturalWidth + 'x' + img.naturalHeight); };
        img.onerror = () => { clearTimeout(timer); res("blocked"); };
        img.src = url;
      });
    })()`);
    r.check("图集解码成功且尺寸是 petdex v1 布局", "1536x1872", decoded);

    r.group("宿主自身在 CSP 下加载插件（真实启动路径，非 CDP 发起）");
    // 启停清单归宿主（C1）：写只认设置窗，打包版也一样（这一组同时在验打包版的门禁与协议）
    const prev = await readEnabledIds(invoke);
    const settingsWin = await openSettingsInvoker(PORT, c).catch(() => null);
    if (settingsWin) await writeEnabledIds(settingsWin.invoke, [PROBE_ID]);
    else r.check("打包版能唤出设置窗（写启停清单要用）", true, false);
    await settingsWin?.close().catch(() => undefined);
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

    r.group("L1 Worker 宿主在打包版 CSP 下成立（ADR-0006）");
    // 打包版没有 /src/*.ts，dev 套件那句「动态 import 宿主模块」在这里必然失败；
    // 所以换 Worker 复装走真实用户的路径：删掉插件目录再装回去，由宿主的 watcher 触发 reconcile
    r.check(
      "CSP 未单列 worker-src（Worker 回落到 script-src 的 'self'）",
      false,
      /worker-src/.test(header),
    );
    installL1Probe("leaf-v1");
    const beforeL1 = await readEnabledIds(invoke);
    const l1Win = await openSettingsInvoker(PORT, c).catch(() => null);
    if (!l1Win) r.check("Worker 组能唤出设置窗（写启停清单要用）", true, false);
    if (l1Win) {
      await l1Win.invoke("permission_revoke", { pluginId: L1_ID });
      await writeEnabledIds(l1Win.invoke, [...new Set([...beforeL1, L1_ID])]);
      await l1Win.close().catch(() => undefined);
    }
    await nap(1200);
    await c.ev(`localStorage.setItem(${JSON.stringify(L1_FLAG)}, ${JSON.stringify(L1_ID)})`);
    await reloadAndWait(c);
    let stopPump = false;
    void pumpConsent(() => stopPump);
    const l1Booted = await waitUntil(c, l1KeyIs("booted", "true"), 90_000);
    r.check("探针在打包版 CSP 下于 Worker 里 activate 成功", true, l1Booted);
    const l1Facts = await readL1Facts(c);
    r.info("入口 URL", String(l1Facts?.entryUrl));
    r.info("裸说明符解析失败的原因", String(l1Facts?.bareImportText));
    r.check("Worker 里没有 window", false, l1Facts?.hasWindow);
    r.check("Worker 里没有 document", false, l1Facts?.hasDocument);
    r.check("__TAURI_INTERNALS__ 在 Worker 里不可达", false, l1Facts?.hasInternals);
    r.check("裸说明符 @tauri-apps/api/core 解析不了", "rejected", l1Facts?.bareImport);
    r.check("入口的相对子模块在打包版 Worker 里取到", "leaf-v1", l1Facts?.leaf);
    r.check("入口 URL 带上 ?v= 令牌", true, /\?v=\d+/.test(String(l1Facts?.entryUrl)));
    r.check("协议表外的方法名被宿主拒", false, l1Facts?.forged?.unknownMethod?.ok);
    r.check("借表内方法发别人的 topic 被前缀归属拦下", false, l1Facts?.forged?.publishAsOther?.ok);
    r.check("跨插件读不到别人的存储", null, l1Facts?.crossPluginRead);

    // 复装之前先把插件目录整个删掉（这也会让宿主把它的授权收走，pump 继续负责点同意框），
    // 再按「leaf.js 先落盘、manifest.json 最后」的顺序装回去 ——
    // 装回时 leaf 的内容就已经是 leaf-v2，新 Worker 取到的必须是新的那一份
    rmSync(L1_DIR, { recursive: true, force: true });
    await nap(2500);
    installL1Probe("leaf-v2");
    const refreshed = await waitUntil(c, l1KeyIs("facts.leaf", JSON.stringify("leaf-v2")), 90_000);
    // 复装这一步也要继续点同意框：删插件目录会触发 prune_orphan_grants 把授权收走，
    // 重新装载就是一次全新的首次授权（不是「缓存里还剩一份」）
    stopPump = true;
    if (!refreshed) r.info("复装后实得的 leaf", String((await readL1Facts(c))?.leaf));
    r.check("换一个 Worker 后取到新内容（no-store 在打包版 Worker 路径上成立）", true, refreshed);
    await c.ev(`localStorage.removeItem(${JSON.stringify(L1_FLAG)})`).catch(() => undefined);

    r.group("无 CSP 违规");
    const violations = c.noise.filter((n) => n.startsWith("CSP:"));
    r.check("违规条数", 0, violations.length);
    for (const n of c.noise.filter((n) => !n.startsWith("CSP:"))) console.log("   " + n);

    // 恢复用户那份清单（写仍然只认设置窗）
    {
      const back = await openSettingsInvoker(PORT, c).catch(() => null);
      if (back) await writeEnabledIds(back.invoke, prev).catch(() => undefined);
      // 撤销会连带清掉该插件的隔离存储目录，比留一份探针写的垃圾干净
      if (back) await back.invoke("permission_revoke", { pluginId: L1_ID }).catch(() => undefined);
      await back?.close().catch(() => undefined);
    }
  } finally {
    exitCode = r.summary() ? 1 : 0;
    c.close();
  }
} catch (err) {
  // 内层 finally 已经把 exitCode 按断言结果算过一次，异常路径必须覆盖回非零：
  // 否则「跑到一半崩了、但已跑的断言全绿」会以 0 退出，CI 看到的是绿
  exitCode = 1;
  console.error("\n校验未启动:", String(err?.message ?? err).split("\n")[0]);
  console.error("若一直连不上 CDP：多半是 dev 实例还开着，单实例插件让 release 直接退出。");
} finally {
  app.kill();
  // 只按「可执行路径正好是本次要验的那个 exe」收残留进程。
  // /IM 按镜像名一刀切会连用户自己开着的那份一起杀掉。
  if (process.platform === "win32") {
    spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Name desktop-pet -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${JSON.stringify(
          EXE,
        )} } | ForEach-Object { Stop-Process -Id $_.Id -Force }`,
      ],
      { stdio: "ignore", shell: false },
    );
  }
  removeFixtures(PLUGINS_DIR);
  rmSync(L1_DIR, { recursive: true, force: true });
}

process.exit(exitCode);

/** Worker 组用的等待与安装：打包版的插件目录在 exe 同级，不是仓库根的 plugins/ */
function nap(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * 把 L1 取证插件装进打包版的插件目录。
 * 顺序是有意的：`leaf.js`（内容按参数写）与 `index.js` 先落盘，`manifest.json` 最后 ——
 * 宿主是在读到 manifest 的那一轮才 reconcile 的，这样「装载」看到的就是这一轮要验的那份 leaf 内容。
 */
function installL1Probe(leafValue) {
  mkdirSync(L1_DIR, { recursive: true });
  writeFileSync(join(L1_DIR, "leaf.js"), `export const LEAF_MARKER = ${JSON.stringify(leafValue)};\n`);
  copyFileSync(join(L1_FIXTURE, "index.js"), join(L1_DIR, "index.js"));
  copyFileSync(join(L1_FIXTURE, "manifest.json"), join(L1_DIR, "manifest.json"));
}

/** 读探针写进自己隔离存储的一条事实（`key` 支持 `facts.leaf` 这种两段路径） */
function l1KeyIs(key, want) {
  const [head, tail] = key.split(".");
  const expr = tail ? `__v?.${tail}` : "__v";
  return `(async () => { try { const __v = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(L1_ID)}, key: ${JSON.stringify(head)} }); return ${expr} === ${want}; } catch { return false; } })()`;
}

async function readL1Facts(c) {
  return c
    .ev(`(async () => { try { return await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(L1_ID)}, key: 'facts' }) ?? null; } catch { return null; } })()`)
    .catch(() => null);
}

/** 授权只能走真实同意框：打包版也一样，所以整轮持续点「允许」 */
async function pumpConsent(stop) {
  while (!stop()) {
    const target = (await listPages(PORT).catch(() => [])).find((t) => /consent/.test(t.url));
    if (!target) {
      await nap(400);
      continue;
    }
    try {
      const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
      try {
        await cs.ev(`document.getElementById('btn-allow').click()`);
      } finally {
        cs.close();
      }
    } catch (e) {
      console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
    }
    await nap(300);
  }
}
