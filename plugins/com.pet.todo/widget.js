// 待办插件的界面渲染。区域约定：
//   badge   = 宠物旁的小徽标（还剩几项）
//   overlay = 贴在宠物头顶的桌面卡片（可勾选）
//   settings= 设置窗里的完整清单与开关
// 渲染契约写法（Worker 路线，ADR-0008 / PLUGIN_SDK.md §5.1）：节点一律经 ctx.dom 创建、
// 事件经节点自身的 on() 订阅，本文件不再直接触碰宿主 realm 的 DOM；
// 所有外部文本一律 textContent 建节点（清单内容来自用户输入，不能拼进标记）；
// 交互只经 ctx.bus 发指令，不挂任何全局回调。
import { TOPIC_CMD, TOPIC_STATUS, TOPIC_WIDGET } from "./topics.js";

const scopes = new WeakMap();

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

/** 订阅界面数据；面板刚建好时主动要一次当前状态（宿主的 `*:widget` 回灌是双保险） */
function watch(ctx, cleanups, render) {
  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (data) => render(data ?? {})));
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
}

const el = (dom, tag, cls, text) => {
  const node = dom.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function button(dom, label, onClick) {
  const btn = el(dom, "button", "td-btn", label);
  btn.type = "button";
  btn.on("click", onClick);
  return btn;
}

/** 一行待办：勾选框 + 文本 + 元信息（优先级 / 到期 / @项目），可选删除按钮 */
function taskRow(dom, task, onToggle, onDelete) {
  const row = el(dom, "div", "td-row");
  const box = el(dom, "input", "td-check");
  box.type = "checkbox";
  box.checked = task.done === true;
  box.on("change", (e) => onToggle?.(task.id, e.target.checked));
  row.append(box, el(dom, "span", "td-text", task.text || task.line || "（空）"));

  const marks = [];
  if (task.priority) marks.push(`(${task.priority})`);
  if (task.meta?.due) marks.push(`due ${task.meta.due}`);
  for (const p of task.projects ?? []) marks.push(`@${p}`);
  if (marks.length) row.append(el(dom, "span", "td-meta", marks.join(" · ")));

  if (onDelete) {
    const del = el(dom, "button", "td-del", "删除");
    del.type = "button";
    del.on("click", () => onDelete(task.id));
    row.append(del);
  }
  return row;
}

/* ---------- 宠物旁徽标 ---------- */
function mountBadge(root, ctx, cleanups) {
  const dom = ctx.dom;
  const style = el(dom, "style");
  style.textContent = `
    .td-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px;
      border-radius:9px; font-size:11px; color:#eaf1f8;
      background:rgba(10,14,20,.55); border:1px solid rgba(255,255,255,.12); }
    .td-badge .dot { width:7px; height:7px; border-radius:50%; background:#9aa4b2; }
  `;
  const badge = el(dom, "div", "td-badge");
  const dot = el(dom, "i", "dot");
  const text = el(dom, "span", null, "待办");
  badge.append(dot, text);
  root.append(style, badge);

  watch(ctx, cleanups, (d) => {
    const open = d.openCount ?? 0;
    dot.style.background = open > 0 ? "#ffb454" : "#7ee2a8";
    text.textContent = open > 0 ? `${open} 项待办` : "没有待办";
  });
}

/* ---------- 桌面卡片 ---------- */
function mountCard(root, ctx, cleanups) {
  const dom = ctx.dom;
  const style = el(dom, "style");
  style.textContent = `
    .td-card { width:300px; padding:11px 13px 12px; border-radius:14px;
      background:rgba(16,18,24,.9); border:1px solid rgba(255,255,255,.1);
      box-shadow:0 8px 26px rgba(0,0,0,.42); color:#f2f5f8;
      font:12.5px/1.5 system-ui,"Segoe UI",sans-serif; }
    .td-card .head { display:flex; align-items:baseline; gap:8px; }
    .td-card .head b { font-size:13px; }
    .td-card .head span { margin-left:auto; font-size:11px; color:#98a2b3; }
    .td-row { display:flex; align-items:center; gap:7px; margin-top:6px; }
    .td-row .td-text { flex:1; min-width:0; white-space:nowrap; overflow:hidden;
      text-overflow:ellipsis; }
    .td-row .td-meta { font-size:10.5px; color:#9aa4b3; flex:none; }
    .td-card .empty { margin-top:8px; color:#7ee2a8; font-size:12px; }
    .td-card input[type=checkbox] { accent-color:#7cc4ff; }
  `;
  const card = el(dom, "div", "td-card");
  const head = el(dom, "div", "head");
  const count = el(dom, "span");
  head.append(el(dom, "b", null, "待办"), count);
  const list = el(dom, "div", "td-list");
  card.append(head, list);
  root.append(style, card);

  const toggle = (id, done) => ctx.bus.publish(TOPIC_CMD, { action: "toggle", id, done });

  watch(ctx, cleanups, (d) => {
    count.textContent = `${d.openCount ?? 0} 项 · 已完成 ${d.doneCount ?? 0}`;
    const items = d.tasks ?? [];
    list.replaceChildren(
      ...(items.length ? items.map((t) => taskRow(dom, t, toggle)) : [el(dom, "div", "empty", "全部清空了 ✨")]),
    );
  });
}

/* ---------- 设置面板 ---------- */
function mountSettings(root, ctx, cleanups) {
  const dom = ctx.dom;
  const style = el(dom, "style");
  style.textContent = `
    .td-set { display:flex; flex-direction:column; gap:8px; font-size:12.5px; color:#2b2f36; }
    .td-set .row { display:flex; gap:6px; align-items:center; }
    .td-set input[type=text] { flex:1; min-width:0; font-size:12px; padding:4px 6px; }
    .td-btn { font-size:12px; padding:4px 12px; border-radius:5px;
      border:1px solid #d0d5dd; background:#fff; cursor:pointer; }
    .td-btn:hover { background:#f2f4f7; }
    .td-set .td-list { max-height:220px; overflow:auto; border:1px solid #eaecf0;
      border-radius:6px; padding:6px; }
    .td-set .td-row .td-text { color:#2b2f36; }
    .td-set .td-row .td-meta { color:#98a2b3; }
    .td-del { border:none; background:none; color:#d92d20; cursor:pointer; font-size:12px; flex:none; }
    .td-set .opts { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
    .td-set .hint { color:#98a2b3; font-size:11px; }
    .td-set .status { min-height:15px; font-size:11.5px; color:#667085; }
  `;
  const box = el(dom, "div", "td-set");

  const input = el(dom, "input");
  input.type = "text";
  input.placeholder = "如：(A) 写周报 due:2026-10-12 @工作 +老板";
  // 文本框要订阅 input：宿主靠快照把最新文本写回节点（回写先于派发，handler 无需做事），
  // 不订阅的话 Enter / 点「添加」时读到的 input.value 会停在旧值。
  input.on("input", () => {});
  const runAdd = () => {
    const text = input.value.trim();
    if (!text) return;
    ctx.bus.publish(TOPIC_CMD, { action: "add", text });
    input.value = "";
  };
  const add = button(dom, "添加", runAdd);
  input.on("keydown", (e) => {
    if (e.key === "Enter") runAdd();
  });
  const row = el(dom, "div", "row");
  row.append(input, add);

  const list = el(dom, "div", "td-list");

  const cardBox = el(dom, "input");
  cardBox.type = "checkbox";
  const cardLabel = el(dom, "label");
  cardLabel.append(cardBox, el(dom, "span", null, " 桌面卡片"));
  const remindBox = el(dom, "input");
  remindBox.type = "checkbox";
  const remindLabel = el(dom, "label");
  remindLabel.append(remindBox, el(dom, "span", null, " 到期提醒"));
  const clearBtn = button(dom, "清掉已完成", () => ctx.bus.publish(TOPIC_CMD, { action: "clearDone" }));
  const opts = el(dom, "div", "opts");
  opts.append(cardLabel, remindLabel, clearBtn);

  const statusLine = el(dom, "div", "status", "正在读取…");
  const hint = el(
    dom,
    "div",
    "hint",
    "字段照 todo.txt 约定：`(A)` 优先级、`due:` 到期、`@项目`、`+上下文`。数据只存在插件自己的目录里。",
  );
  box.append(row, list, opts, statusLine, hint);
  root.append(style, box);

  const sendConfig = () =>
    ctx.bus.publish(TOPIC_CMD, {
      action: "config",
      card: cardBox.checked,
      remind: remindBox.checked,
    });
  cardBox.on("change", sendConfig);
  remindBox.on("change", sendConfig);

  const toggle = (id, done) => ctx.bus.publish(TOPIC_CMD, { action: "toggle", id, done });
  const remove = (id) => ctx.bus.publish(TOPIC_CMD, { action: "remove", id });

  watch(ctx, cleanups, (d) => {
    const items = d.tasks ?? [];
    list.replaceChildren(
      ...(items.length
        ? items.map((t) => taskRow(dom, t, toggle, remove))
        : [el(dom, "div", "hint", "还没有待办，先加一条。")]),
    );
    cardBox.checked = d.config?.card === true;
    remindBox.checked = d.config?.remind !== false;
    statusLine.textContent = `未完成 ${d.openCount ?? 0} · 已完成 ${d.doneCount ?? 0}`;
  });

  cleanups.push(ctx.bus.subscribe(TOPIC_STATUS, (s) => {
    if (typeof s?.text === "string") statusLine.textContent = s.text;
  }));
}
