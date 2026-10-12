// 极简 WebView2 CDP 客户端与断言收集器。零依赖：Node 24 自带 fetch 与全局 WebSocket。
// 用途见 tests/e2e/verify-isolation.mjs 顶部说明。

export async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()).filter((t) => t.type === "page");
}

/** 等到有匹配的 page target 出现（应用启动/窗口创建是异步的） */
export async function waitForPage(port, match, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const hit = (await listPages(port)).find(match);
      if (hit) return hit;
    } catch {
      /* CDP 端口还没起来 */
    }
    if (Date.now() > until) throw new Error(`等不到匹配的 target（port=${port}）`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

export async function attach(port, match, timeoutMs = 90_000) {
  const target = await waitForPage(port, match, timeoutMs);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`CDP websocket 连接失败: ${target.url}`));
  });

  let seq = 0;
  const pending = new Map();
  const onceWatchers = [];
  const noise = [];
  /**
   * 导航过渡期的 Tauri 告警单独记账。页面被换掉时，旧文档在飞的 IPC 回调会带着
   * 「Couldn't find callback id」/「IPC custom protocol failed」迟到，落到新文档的
   * console 里 —— 这两条文案本身就是 Tauri 对「导航打断了 IPC」的自述，且它会自动
   * 回退到 postMessage 继续工作，与被测行为无关；插件越多、轮询越密越容易撞上。
   * 不按时间窗筛（迟到的可能几十秒后才落），只认这两条签名，其余一律进 noise 照常断言。
   * 每套回归都会把 transitionNoise 的条数打出来，不是静默吞掉。
   */
  const transitionNoise = [];
  const TRANSITION_SIGNATURE = /Couldn't find callback id|IPC custom protocol failed/;
  const pushNoise = (text) => {
    if (TRANSITION_SIGNATURE.test(text)) transitionNoise.push(text);
    else noise.push(text);
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    for (let i = onceWatchers.length - 1; i >= 0; i--) {
      if (onceWatchers[i].method === msg.method) {
        onceWatchers[i].done();
        onceWatchers.splice(i, 1);
      }
    }
    if (msg.method === "Log.entryAdded") {
      const { text, level, url } = msg.params.entry;
      // 缺 favicon 与隔离无关，但它会淹没真消息；其余网络错误（含插件文件 404）保留
      const isFavicon = typeof url === "string" && url.endsWith("/favicon.ico");
      const where = url ? ` @ ${url}` : "";
      if (/Content Security|Refused to|do not load/i.test(text)) pushNoise(`CSP: ${text.slice(0, 200)}${where}`);
      else if (level === "error" && !isFavicon) pushNoise(`日志: ${text.slice(0, 160)}${where}`);
    }
    // 宿主的 reportError 只写 console.error；不采集就等于失败原因不可见
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      const text = (msg.params.args ?? [])
        .map((a) => a?.description ?? a?.value ?? a?.type)
        .join(" ")
        .slice(0, 300);
      const at = msg.params.stackTrace?.callFrames?.[0]?.url;
      pushNoise(`console.${msg.params.type}: ${text}${at ? ` @ ${at}:${msg.params.stackTrace.callFrames[0].lineNumber}` : ""}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      pushNoise(`异常: ${(d.exception?.description ?? d.text ?? "?").split("\n")[0].slice(0, 200)}`);
    }
  };

  const send = (method, params = {}, timeoutMs = 20_000) =>
    new Promise((res, rej) => {
      const id = ++seq;
      // 必须有超时：调试端点一旦失去响应（窗口反复建销、客户端堆积），
      // 没有超时的话整条断言链会永久挂住，看起来像「构建/测试偶发失败」，
      // 实际上没有任何输出线索。
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP ${method} 超时 ${timeoutMs}ms（调试端点可能已失去响应，重启 dev 实例再试）`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Log.enable");

  return {
    url: target.url,
    send,
    noise,
    transitionNoise,
    /** 等一次事件（用于确认导航真的完成，而不是靠 sleep 赌） */
    once(method, timeoutMs = 30_000) {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`等 ${method} 超时`)), timeoutMs);
        onceWatchers.push({ method, done: () => (clearTimeout(timer), res()) });
      });
    },
    /**
     * 在页面里求值。注意：CDP 发起的代码不受 CSP 约束，
     * 不要用这里的 eval/import 结果来判断 CSP 是否生效 —— 那必须看页面自身代码的副作用。
     */
    async ev(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const err = r.result?.exceptionDetails;
      if (err) {
        throw new Error((err.exception?.description ?? err.text ?? JSON.stringify(err)).split("\n").slice(0, 3).join(" | "));
      }
      return r.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

/** 断言收集器：全部跑完再统一报告，非零退出码反映给 CI/npm */
export function createReport(title) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  console.log(`\n=== ${title} ===`);
  return {
    group: (name) => console.log(`\n-- ${name}`),
    check(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : ` — 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`}`);
      if (ok) pass++;
      else {
        fail++;
        failures.push(label);
      }
    },
    info: (label, value) => console.log(`  · ${label}: ${value}`),
    summary() {
      console.log(`\n${pass} passed, ${fail} failed`);
      if (failures.length) console.log("失败项：\n  " + failures.join("\n  "));
      return fail;
    },
  };
}

/** 直打宿主命令：绕过 JS 能力桥，验的是 Rust 侧规则本身 */
export function hostInvoke(c) {
  return async (cmd, args = {}) =>
    c.ev(
      `(async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}); return { ok: true, v }; } catch (e) { return { ok: false, e: typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)) }; } })()`,
    );
}

/** 轮询页面表达式直到为真 */
export async function waitUntil(c, expression, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await c.ev(expression).catch(() => false)) return true;
    await new Promise((res) => setTimeout(res, 800));
  }
  return false;
}

/**
 * 「只认设置窗」的命令就从设置窗发起：撤销授权、看授权表、装形象这一类门禁
 * 按窗口 label 判定，从宠物窗调用必然被拒 —— 那正是门禁本身，不是脚本写错了。
 * 由宠物窗自己把设置窗唤出来（settings_show 只认宠物窗），跟用户点托盘是同一条路。
 */
export async function openSettingsInvoker(port, petClient, timeoutMs = 25_000) {
  const invoke = hostInvoke(petClient);
  await invoke("settings_show");
  const target = await waitForPage(port, (t) => /localhost:1420\/settings\.html/.test(t.url), timeoutMs);
  const client = await attach(port, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 15_000);
  await new Promise((res) => setTimeout(res, 1200)); // 等设置页把列表渲染出来，别抢它的首屏
  return {
    client,
    invoke: hostInvoke(client),
    async close() {
      await hostInvoke(client)("plugin:window|close").catch(() => undefined);
      client.close();
    },
  };
}

/**
 * 重载并确认文档真的加载完。
 * 导航刚发生时 CDP 的隐式上下文可能仍指向旧文档，直接轮询会一路拿到旧结果（实测偶发假失败）。
 * 旧文档在飞的 IPC 回调会在之后迟到成两条 Tauri 告警，那属于导航产物，
 * 由 attach 里的 pushNoise 归到 transitionNoise（各脚本会把它条数打出来）。
 */
export async function reloadAndWait(c) {
  await c.send("Page.enable");
  const loaded = c.once("Page.loadEventFired");
  await c.send("Page.reload", { ignoreCache: true });
  await loaded;
  // load 之后宿主还要异步跑 reconcile 与插件激活，交给调用方的 waitUntil
  await new Promise((res) => setTimeout(res, 600));
}
