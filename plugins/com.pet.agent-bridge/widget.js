// 状态卡渲染器。区域约定与心率插件一致：
//   badge   = 宠物旁的一行小字
//   overlay = 桌面左上角的大卡（主视图）
//   settings= 设置窗里的隐私开关 + Qoder hook 接入（ctx.host 只注入给这个区）
// 所有数据来自 `${PID}:widget` topic；敏感字段在 index.js 就已按开关剥掉，
// 这里拿不到就不可能显示，不存在「渲染后再藏起来」的漏洞。
import { TOPIC_CMD, TOPIC_WIDGET } from "./topics.js";

const scopes = new WeakMap();

const STATE_COLOR = {
  running: "#7cc4ff",
  needs_input: "#ffb454",
  completed: "#7ee2a8",
  idle: "#9aa4b2",
};

export function mount(root, ctx) {
  const cleanups = [];
  scopes.set(root, cleanups);
  if (ctx.region === "badge") return mountBadge(root, ctx, cleanups);
  if (ctx.region === "overlay") return mountCard(root, ctx, cleanups);
  if (ctx.region === "settings") return mountSettings(root, ctx, cleanups);
  return undefined;
}

export function unmount(root) {
  for (const off of scopes.get(root) ?? []) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
  scopes.delete(root);
}

function watch(ctx, cleanups, render) {
  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (data) => render(data ?? {})));
}

/* ---------- 宠物旁小字 ---------- */
function mountBadge(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px;
      border-radius:9px; font-size:11px; color:#eaf1f8;
      background:rgba(10,14,20,.55); border:1px solid rgba(255,255,255,.12); }
    .ag-badge .dot { width:7px; height:7px; border-radius:50%; background:#9aa4b2; }
  `;
  const el = ctx.dom.createElement("div");
  el.className = "ag-badge";
  const dot = ctx.dom.createElement("i");
  dot.className = "dot";
  const text = ctx.dom.createElement("span");
  el.append(dot, text);
  // 空态（没见过任何会话活动）什么都不进树，外壳尺寸才量得到 0（ADR-0010 落地口径第 1 条）
  root.append(style);

  watch(ctx, cleanups, (d) => {
    const steps = typeof d.steps === "number" ? d.steps : 0;
    const idleEmpty =
      (d.state ?? "idle") === "idle" && steps === 0 && !d.toolName && !d.title && !d.detail;
    if (idleEmpty) {
      el.remove();
      return;
    }
    dot.style.background = STATE_COLOR[d.state] ?? "#9aa4b2";
    text.textContent = `${d.label ?? d.state ?? "待命"}${d.steps ? ` · ${d.steps} 步` : ""}`;
    root.append(el);
  });
}

/* ---------- 桌面左上角大卡 ---------- */
function mountCard(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-card { width: 300px; padding: 12px 14px 13px; border-radius: 14px;
      background: rgba(16,18,24,.9); border:1px solid rgba(255,255,255,.1);
      box-shadow: 0 8px 26px rgba(0,0,0,.42); color:#f2f5f8;
      font: 13px/1.5 system-ui, "Segoe UI", sans-serif; }
    .ag-card .title { font-size:13px; font-weight:600; color:#fff;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ag-card .row { display:flex; align-items:center; gap:7px; margin-top:7px; }
    .ag-card .dot { width:8px; height:8px; border-radius:50%; background:#9aa4b2; flex:none; }
    .ag-card .label { font-size:12.5px; }
    .ag-card .steps { margin-left:auto; font-size:11px; color:#98a2b3;
      font-variant-numeric: tabular-nums; }
    .ag-card .detail { margin-top:6px; padding-left:15px; font-size:11.5px; color:#b6c0cd;
      font-family: ui-monospace, Consolas, monospace;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ag-card.idle { opacity:.62; }
  `;
  const el = ctx.dom.createElement("div");
  el.className = "ag-card idle";
  const title = ctx.dom.createElement("div");
  title.className = "title";
  const row = ctx.dom.createElement("div");
  row.className = "row";
  const dot = ctx.dom.createElement("i");
  dot.className = "dot";
  const label = ctx.dom.createElement("span");
  label.className = "label";
  const steps = ctx.dom.createElement("span");
  steps.className = "steps";
  row.append(dot, label, steps);
  const detail = ctx.dom.createElement("div");
  detail.className = "detail";
  el.append(title, row, detail);
  root.append(style, el);

  watch(ctx, cleanups, (d) => {
    el.classList.toggle("idle", d.state === "idle");
    // 标题被关掉时显示占位，不留空行，也不泄露任何会话内容
    title.textContent = d.title || "Agent 会话";
    dot.style.background = STATE_COLOR[d.state] ?? "#9aa4b2";
    label.textContent = d.label ?? d.state ?? "待命";
    label.style.color = STATE_COLOR[d.state] ?? "#f2f5f8";
    steps.textContent = d.steps ? `${d.steps} 步` : "";
    detail.textContent = d.detail || (d.toolName ? d.toolName : "");
  });
}

/* ---------- 设置面板：隐私开关 ---------- */
function mountSettings(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-set { font-size:12px; color:#475467; display:grid; gap:6px; }
    .ag-set label { display:flex; align-items:center; gap:6px; }
    .ag-set .note { color:#98a2b3; font-size:11px; }
  `;
  const box = ctx.dom.createElement("div");
  box.className = "ag-set";

  const mk = (key, text, note) => {
    const label = ctx.dom.createElement("label");
    const input = ctx.dom.createElement("input");
    input.type = "checkbox";
    input.dataset.key = key;
    const span = ctx.dom.createElement("span");
    span.textContent = text;
    label.append(input, span);
    box.append(label);
    if (note) {
      const p = ctx.dom.createElement("div");
      p.className = "note";
      p.textContent = note;
      box.append(p);
    }
    return input;
  };
  const title = mk("showTitle", "显示会话标题（首条输入前 48 字）");
  const detail = mk("showDetail", "显示命令 / 路径摘要");
  const note = ctx.dom.createElement("div");
  note.className = "note";
  note.textContent = "默认都关：只显工具名与步数。开了就等于把会话内容常驻显示在桌面上。";
  box.append(note);
  root.append(style, box);

  const send = () =>
    ctx.bus.publish(TOPIC_CMD, {
      action: "config",
      showTitle: title.checked,
      showDetail: detail.checked,
    });
  title.on("change", send);
  detail.on("change", send);
  // 面板是新建的、配置是早就存在的：开口要一次当前值，否则两个开关都显示成关
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
  cleanups.push(() => {
    title.off("change");
    detail.off("change");
  });

  // 回显当前开关：payload 里带着 config，避免面板重开后显示成默认值
  watch(ctx, cleanups, (d) => {
    title.checked = d.showTitle === true;
    detail.checked = d.showDetail === true;
  });

  // Qoder hook 的装/卸入口（B2 把宿主那张卡片删掉后，这里就是唯一入口）
  mountHookPanel(root, ctx);
}


/* ---------- 设置面板：Qoder hook 接入（settings 区专属能力 agent:hooks，见 ADR-0001） ---------- */
function mountHookPanel(root, ctx) {
  const api = ctx.host && ctx.host.agentHooks;
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .hk-box { margin-top:12px; padding-top:10px; border-top:1px dashed rgba(71,84,103,.3);
      font-size:12px; color:#475467; display:grid; gap:6px; }
    .hk-box .hk-hd { font-weight:600; color:#344054; }
    .hk-box .hk-actions { display:flex; gap:6px; }
    .hk-box button { font:inherit; padding:2px 10px; }
    .hk-box .hk-status { white-space:pre-wrap; word-break:break-all; }
    .hk-box .hk-status.warn { color:#b54708; }
  `;
  const box = ctx.dom.createElement("div");
  box.className = "hk-box";
  const hd = ctx.dom.createElement("div");
  hd.className = "hk-hd";
  hd.textContent = "Qoder hook 接入";
  const st = ctx.dom.createElement("div");
  st.className = "hk-status";
  st.dataset.state = "loading";
  st.textContent = "正在读取状态…";
  const actions = ctx.dom.createElement("div");
  actions.className = "hk-actions";
  box.append(hd, st, actions);
  root.append(style, box);

  if (!api) {
    st.dataset.state = "error";
    st.textContent = "当前环境没有 hook 能力通道（应只在设置页出现）。";
    return;
  }

  // 渲染只有一个口径：宿主的 status() 快照。外部值（路径/exe/error）一律 textContent，不拼 HTML
  const render = (info) => {
    const files = Array.isArray(info?.files) ? info.files : [];
    const lines = [];
    if (files.length === 0) {
      st.dataset.state = "absent";
      lines.push("未安装：没找到 Qoder 的配置目录（~/.qoder 或 ~/.qoder-cn）。");
    } else if (info.installed === true) {
      st.dataset.state = "installed";
      lines.push(`已安装：每个文件 ${info.expectedPerFile} 个事件，共 ${info.managed} 条。`);
    } else if (Number(info.managed) > 0) {
      st.dataset.state = "repair";
      lines.push(`需要修复（条数不对）：当前共 ${info.managed} 条，应为 ${files.length * info.expectedPerFile} 条。`);
    } else {
      st.dataset.state = "absent";
      lines.push("未安装。");
    }
    for (const f of files) lines.push(`· ${f.path} — ${f.error ? `失败：${f.error}` : `${f.managed} 条`}`);
    if (info.exe) lines.push(`hook 命令指向 ${info.exe}`);
    st.textContent = lines.join("\n");
    st.classList.toggle("warn", st.dataset.state === "repair");
  };

  const refresh = async () => {
    try {
      render(await api.status());
    } catch (err) {
      st.dataset.state = "error";
      st.textContent = `读取状态失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const run = async (label, fn) => {
    st.dataset.state = "loading";
    st.textContent = `${label}中…`;
    try {
      await fn();
      // install/uninstall 的返回是逐文件报告、没有 exe/expectedPerFile：统一再拉一次 status 重渲染
      // （仍是宿主的返回值，不缓存自己算的数）
      await refresh();
    } catch (err) {
      st.dataset.state = "error";
      st.textContent = `${label}失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const button = (text, cls, fn) => {
    const b = ctx.dom.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.on("click", () => void fn());
    return b;
  };
  actions.append(
    button("安装", "hk-install", () => run("安装", () => api.install())),
    button("卸载", "hk-uninstall", () => run("卸载", () => api.uninstall())),
    button("刷新", "hk-refresh", () => refresh()),
  );

  // 挂载即拉回显：不先渲染模板默认值、也不缓存自己算的数（PLUGIN_SDK §5 第 3 条）
  void refresh();
}
