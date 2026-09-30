// 状态卡渲染器。区域约定与心率插件一致：
//   badge   = 宠物旁的一行小字
//   overlay = 桌面左上角的大卡（主视图）
//   settings= 设置窗里的隐私开关
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
  const style = document.createElement("style");
  style.textContent = `
    .ag-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px;
      border-radius:9px; font-size:11px; color:#eaf1f8;
      background:rgba(10,14,20,.55); border:1px solid rgba(255,255,255,.12); }
    .ag-badge .dot { width:7px; height:7px; border-radius:50%; background:#9aa4b2; }
  `;
  const el = document.createElement("div");
  el.className = "ag-badge";
  const dot = document.createElement("i");
  dot.className = "dot";
  const text = document.createElement("span");
  el.append(dot, text);
  root.append(style, el);

  watch(ctx, cleanups, (d) => {
    dot.style.background = STATE_COLOR[d.state] ?? "#9aa4b2";
    text.textContent = `${d.label ?? d.state ?? "待命"}${d.steps ? ` · ${d.steps} 步` : ""}`;
  });
}

/* ---------- 桌面左上角大卡 ---------- */
function mountCard(root, ctx, cleanups) {
  const style = document.createElement("style");
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
  const el = document.createElement("div");
  el.className = "ag-card idle";
  const title = document.createElement("div");
  title.className = "title";
  const row = document.createElement("div");
  row.className = "row";
  const dot = document.createElement("i");
  dot.className = "dot";
  const label = document.createElement("span");
  label.className = "label";
  const steps = document.createElement("span");
  steps.className = "steps";
  row.append(dot, label, steps);
  const detail = document.createElement("div");
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
  const style = document.createElement("style");
  style.textContent = `
    .ag-set { font-size:12px; color:#475467; display:grid; gap:6px; }
    .ag-set label { display:flex; align-items:center; gap:6px; }
    .ag-set .note { color:#98a2b3; font-size:11px; }
  `;
  const box = document.createElement("div");
  box.className = "ag-set";

  const mk = (key, text, note) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.key = key;
    label.append(input, document.createTextNode(text));
    box.append(label);
    if (note) {
      const p = document.createElement("div");
      p.className = "note";
      p.textContent = note;
      box.append(p);
    }
    return input;
  };
  const title = mk("showTitle", "显示会话标题（首条输入前 48 字）");
  const detail = mk("showDetail", "显示命令 / 路径摘要");
  const note = document.createElement("div");
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
  title.addEventListener("change", send);
  detail.addEventListener("change", send);
  cleanups.push(() => {
    title.removeEventListener("change", send);
    detail.removeEventListener("change", send);
  });

  // 回显当前开关：payload 里带着 config，避免面板重开后显示成默认值
  watch(ctx, cleanups, (d) => {
    title.checked = d.showTitle === true;
    detail.checked = d.showDetail === true;
  });
}

