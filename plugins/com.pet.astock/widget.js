// 盯盘插件的界面：badge（宠物旁小字）、overlay（左上角盯盘卡）、settings（插件页）。
// 三个区域共用一份由 index.js 推来的视图数据（`com.pet.astock:widget`），
// 界面自己不发请求、也不算规则 —— 这样重新挂载时只要宿主回灌那一份就够了。
//
// 遵守 SDK 三条硬规矩：只往 shadow root 里写；清理表按挂载实例存（WeakMap）；
// 外部数据一律 textContent，绝不拼进 innerHTML（股票名、搜索结果、行情值都算外部数据）。
import { PID, TOPIC_CMD, TOPIC_PANEL, TOPIC_STATUS, TOPIC_SUGGEST, TOPIC_WIDGET } from "./topics.js";
import { KLINE_PERIODS } from "./market.js";
import { depthRows, drawKline, drawTrend } from "./charts.js";

const scopes = new WeakMap();

export function mount(root, ctx) {
  const cleanups = [];
  scopes.set(root, cleanups);
  if (ctx.region === "badge") mountBadge(root, ctx, cleanups);
  else if (ctx.region === "overlay") mountOverlay(root, ctx, cleanups);
  else if (ctx.region === "settings") mountSettings(root, ctx, cleanups);
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

/* ================= 共用小工具 ================= */

function addStyle(root, css) {
  const node = document.createElement("style");
  node.textContent = css;
  root.append(node);
}

function tag(name, cls) {
  const node = document.createElement(name);
  if (cls) node.className = cls;
  return node;
}

function text(content, cls) {
  const node = tag("span", cls);
  node.textContent = String(content ?? "");
  return node;
}

function button(label, cls) {
  const node = tag("button", cls);
  node.type = "button";
  node.textContent = label;
  return node;
}

function input(type, cls) {
  const node = tag("input", cls);
  node.type = type;
  return node;
}

/** A股习惯：红涨绿跌。数值缺失（停牌/未开盘）走灰色，不显示 NaN */
function toneOf(q) {
  const pct = q?.pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "flat";
  return pct > 0 ? "up" : pct < 0 ? "down" : "flat";
}

function fmtPrice(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";
}

function fmtPct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function clockOf(ms) {
  return typeof ms === "number"
    ? new Date(ms).toLocaleTimeString("zh-CN", { hour12: false })
    : "";
}

const PHASE_TEXT = {
  pre: "开盘前",
  auction: "集合竞价",
  morning: "上午盘中",
  lunch: "午间休市",
  afternoon: "下午盘中",
  closed: "已收盘",
  weekend: "周末休市",
};

/**
 * 订阅视图数据；返回退订函数交给 cleanups。
 * beatMs > 0 时定时重发一次 sync —— 设置页用它给盘面面板续期（人不在页上就没人续，
 * 主逻辑那边 90 秒后自动停止额外出网）。
 */
function watchView(ctx, render, { beatMs = 0 } = {}) {
  const off = ctx.bus.subscribe(TOPIC_WIDGET, (d) => render(d ?? {}));
  ctx.bus.publish(TOPIC_CMD, { action: "sync" }); // 面板刚建好时主动要一份（宿主回灌是双保险）
  if (!(beatMs > 0)) return off;
  const timer = setInterval(() => ctx.bus.publish(TOPIC_CMD, { action: "sync" }), beatMs);
  return () => {
    clearInterval(timer);
    off();
  };
}

/* ================= badge：宠物旁小字 ================= */

function mountBadge(root, ctx, cleanups) {
  addStyle(
    root,
    `
    .astock-badge {
      font: 12px/1.35 "Segoe UI", "Microsoft YaHei", sans-serif;
      background: rgba(17,19,24,.82); color: #e6e8ee; border-radius: 999px;
      padding: 3px 9px; display: inline-flex; gap: 6px; align-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.28); white-space: nowrap;
    }
    .astock-badge .nm { max-width: 92px; overflow: hidden; text-overflow: ellipsis; }
    .up { color: #ff6b6b; } .down { color: #4ade80; } .flat { color: #cbd2dc; }
    `,
  );
  const box = tag("div", "astock-badge");
  const nm = text("盯盘", "nm");
  const pc = text("", "flat");
  box.append(nm, pc);
  root.append(box);

  cleanups.push(
    watchView(ctx, (d) => {
      const list = d.watch ?? [];
      const first = list.length ? d.quotes?.[list[0].secid] : null;
      const idx = d.config?.showIndex ? d.quotes?.[d.config.indexSecid] : null;
      const q = first ?? idx;
      box.style.display = q || list.length ? "inline-flex" : "none";
      nm.textContent = q?.name ?? (list.length ? "盯盘" : "未加自选");
      pc.textContent = q ? fmtPct(q.pct) : "";
      pc.className = toneOf(q);
    }),
  );
}

/* ================= overlay：桌面左上角盯盘卡 ================= */

function mountOverlay(root, ctx, cleanups) {
  addStyle(
    root,
    `
    .card {
      font: 12px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
      background: rgba(17,19,24,.86); color: #e6e8ee; border-radius: 12px;
      padding: 8px 10px; max-width: 300px; box-shadow: 0 6px 22px rgba(0,0,0,.34);
    }
    .hd { display: flex; justify-content: space-between; font-size: 11px; color: #9aa3b2; margin-bottom: 4px; gap: 10px; }
    .row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: baseline; padding: 1px 0; }
    .row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
    .row .pr, .row .pc { font-variant-numeric: tabular-nums; }
    .row .pc { min-width: 58px; text-align: right; }
    .up { color: #ff6b6b; } .down { color: #4ade80; } .flat { color: #cbd2dc; }
    .idx { border-top: 1px solid rgba(255,255,255,.12); margin-top: 4px; padding-top: 4px; }
    .empty { color: #9aa3b2; }
    `,
  );
  const card = tag("div", "card");
  const phase = text("");
  const updated = text("");
  const head = tag("div", "hd");
  head.append(phase, updated);
  const body = tag("div");
  card.append(head, body);
  root.append(card);

  const rowOf = (q, name, cls) => {
    const row = tag("div", `row ${cls ?? ""}`);
    row.append(text(q?.name ?? name, "nm"), text(fmtPrice(q?.price), "pr"), text(fmtPct(q?.pct), toneOf(q)));
    row.lastChild.className = `pc ${toneOf(q)}`;
    return row;
  };

  cleanups.push(
    watchView(ctx, (d) => {
      phase.textContent = PHASE_TEXT[d.session?.phase] ?? "";
      updated.textContent = clockOf(d.updatedAt);
      body.replaceChildren();
      const list = d.watch ?? [];
      if (!list.length) {
        body.append(text("还没有自选股，去插件页添加", "empty"));
        return;
      }
      for (const item of list) body.append(rowOf(d.quotes?.[item.secid], item.name));
      const idxQ = d.config?.showIndex ? d.quotes?.[d.config.indexSecid] : null;
      if (idxQ) body.append(rowOf(idxQ, idxQ.name, "idx"));
    }),
  );
}

/* ================= settings：插件页 ================= */

const INDEXES = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
  { secid: "1.000688", name: "科创50" },
  { secid: "1.000300", name: "沪深300" },
];

const MODE_TEXT = { badge: "宠物旁小字", overlay: "桌面左上角盯盘卡", off: "不显示" };

function mountSettings(root, ctx, cleanups) {
  addStyle(
    root,
    `
    .wrap { font: 13px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; color: #2b2f36; display: flex; flex-direction: column; gap: 14px; }
    .sec > .sec-t { font-size: 12px; color: #98a2b3; margin-bottom: 4px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .row + .row { margin-top: 6px; }
    input[type=text], select { font: inherit; font-size: 12px; padding: 4px 7px; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; }
    input.num { width: 74px; }
    button { font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; border: 1px solid #d0d5dd; background: #f9fafb; cursor: pointer; }
    button:hover { background: #f2f4f7; }
    button.primary { background: #2f9e63; border-color: #2f9e63; color: #fff; }
    button.danger { color: #b3261e; }
    .status { font-size: 12px; color: #667085; min-height: 18px; }
    .status.ok { color: #2f9e63; } .status.error { color: #d92d20; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; color: #98a2b3; font-weight: 500; padding: 2px 4px; white-space: nowrap; }
    td { padding: 3px 4px; border-top: 1px solid #eaecf0; vertical-align: middle; white-space: nowrap; }
    td:nth-child(1) { white-space: normal; }
    td.quote { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .up { color: #d92d20; } .down { color: #0f9d58; } .flat { color: #667085; }
    .muted { color: #98a2b3; font-size: 11px; }
    .sug { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .sug .item { display: flex; gap: 8px; align-items: center; border: 1px solid #eaecf0; border-radius: 6px; padding: 3px 8px; font-size: 12px; }
    .sug .item span { flex: 1; }
    .radios { display: flex; gap: 14px; flex-wrap: wrap; }
    .radios label, .checks label { display: flex; gap: 4px; align-items: center; font-size: 12px; }
    .checks { display: flex; gap: 16px; flex-wrap: wrap; }
    .alerts { font-size: 12px; color: #475467; display: flex; flex-direction: column; gap: 2px; }
    tbody tr.pick { cursor: pointer; }
    tbody tr.sel td { background: #eef6f1; }
    .panel-hd { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; }
    .panel-hd .nm { font-size: 14px; font-weight: 600; color: #2b2f36; }
    .tabs { display: inline-flex; gap: 4px; }
    .tabs button.on { background: #2f9e63; border-color: #2f9e63; color: #fff; }
    .chart { display: block; margin-top: 6px; background: #11131a; border-radius: 8px; overflow: hidden; }
    .chart canvas { display: block; width: 100%; height: 132px; }
    table.depth { margin-top: 8px; font-variant-numeric: tabular-nums; }
    table.depth td.bar { width: 40%; }
    table.depth .w { display: block; height: 8px; border-radius: 3px; background: #d0d5dd; }
    table.depth .mid td { background: #f9fafb; font-weight: 600; }
    .ask .w { background: #f3b7b2; } .bid .w { background: #a9e0c3; }
    .panel-grid { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .panel-grid > .chart-col { flex: 1 1 300px; min-width: 260px; }
    .panel-grid > .depth-col { flex: 0 1 240px; }
    `,
  );

  const wrap = tag("div", "wrap");
  root.append(wrap);

  let lastStatusAt = 0; // 用户刚操作过 → 状态行保留操作结果几秒，不被下一轮回显盖掉
  const statusLine = tag("div", "status");
  const setStatus = (t, level = "info") => {
    lastStatusAt = Date.now();
    statusLine.textContent = t;
    statusLine.className = `status${level === "info" ? "" : ` ${level}`}`;
  };
  statusLine.textContent = "正在读取当前配置…";

  /* ---------- 添加自选 ---------- */
  const addInput = input("text");
  addInput.placeholder = "代码或名称，例如 600519 / 茅台";
  addInput.style.flex = "1";
  addInput.style.minWidth = "170px";
  const searchBtn = button("搜索");
  const addBtn = button("直接添加", "primary");
  const sugBox = tag("div", "sug");
  let suggestions = [];

  const renderSug = () => {
    sugBox.replaceChildren();
    for (const row of suggestions) {
      const item = tag("div", "item");
      const add = button("添加");
      add.onclick = () => {
        ctx.bus.publish(TOPIC_CMD, { action: "add", secid: row.secid, code: row.code, name: row.name });
        suggestions = suggestions.filter((s) => s.secid !== row.secid);
        renderSug();
      };
      item.append(text(`${row.name}（${row.code}${row.type ? ` · ${row.type}` : ""}）`), add);
      sugBox.append(item);
    }
  };

  searchBtn.onclick = () => {
    const kw = addInput.value.trim();
    if (!kw) return setStatus("先输入代码或名称关键字", "error");
    setStatus(`正在搜索「${kw}」…`);
    ctx.bus.publish(TOPIC_CMD, { action: "search", keyword: kw });
  };
  addBtn.onclick = () => {
    const v = addInput.value.trim();
    if (!v) return setStatus("先输入 6 位代码", "error");
    ctx.bus.publish(TOPIC_CMD, { action: "add", input: v });
    addInput.value = "";
  };
  addInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBtn.click();
    }
  };

  /* ---------- 自选列表与阈值 ---------- */
  const HEADS = ["名称", "现价 / 涨跌", "涨到", "跌到", "±%", "停", ""];
  const headRow = tag("tr");
  for (const label of HEADS) {
    const th = tag("th");
    th.textContent = label;
    headRow.append(th);
  }
  const thead = tag("thead");
  thead.append(headRow);
  const tbody = tag("tbody");
  const table = tag("table");
  table.append(thead, tbody);

  // 两步确认，避免误点把用户的自选与阈值一次清光
  const clearBtn = button("清空自选", "danger");
  let clearArmed = false;
  clearBtn.onclick = () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = "再点一次确认清空";
      setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = "清空自选";
      }, 4000);
      return;
    }
    ctx.bus.publish(TOPIC_CMD, { action: "clear" });
    clearArmed = false;
    clearBtn.textContent = "清空自选";
  };

  /* ---------- 显示方式 / 刷新 / 提醒 ---------- */
  const modeInputs = {};
  const radios = tag("div", "radios");
  for (const value of ["badge", "overlay", "off"]) {
    const box = input("radio");
    box.name = "astock-mode";
    box.value = value;
    box.onchange = () => {
      if (box.checked) ctx.bus.publish(TOPIC_CMD, { action: "config", value: { mode: value } });
    };
    const label = tag("label");
    label.append(box, document.createTextNode(MODE_TEXT[value]));
    radios.append(label);
    modeInputs[value] = box;
  }

  const intervalInput = input("text", "num");
  intervalInput.placeholder = "20";
  const intervalBtn = button("应用");
  intervalBtn.onclick = () => {
    const n = Number(intervalInput.value);
    if (!Number.isFinite(n) || n < 10) return setStatus("间隔至少 10 秒", "error");
    ctx.bus.publish(TOPIC_CMD, { action: "config", value: { intervalSec: Math.round(n) } });
  };
  const refreshBtn = button("立刻刷新");
  refreshBtn.onclick = () => ctx.bus.publish(TOPIC_CMD, { action: "refresh" });
  const testBtn = button("试一条提醒");
  testBtn.onclick = () => ctx.bus.publish(TOPIC_CMD, { action: "testAlert" });

  const alertsBox = input("checkbox");
  alertsBox.onchange = () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { alertsOn: alertsBox.checked } });
  const petBox = input("checkbox");
  petBox.onchange = () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { petOn: petBox.checked } });
  const showIndexBox = input("checkbox");
  showIndexBox.onchange = () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { showIndex: showIndexBox.checked } });
  const indexSel = tag("select");
  for (const idx of INDEXES) {
    const opt = tag("option");
    opt.value = idx.secid;
    opt.textContent = idx.name;
    indexSel.append(opt);
  }
  indexSel.onchange = () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { indexSecid: indexSel.value } });

  const alertList = tag("div", "alerts");
  const netLine = tag("div", "muted");

  const section = (title, ...nodes) => {
    const box = tag("div", "sec");
    const t = tag("div", "sec-t");
    t.textContent = title;
    box.append(t, ...nodes);
    return box;
  };

  /* ---------- 选中个股的盘面：分时 / K线 / 五档 ---------- */
  const panelName = text("点下面一行自选股看盘口与曲线", "nm");
  const panelSub = text("", "muted");
  const panelErr = text("", "muted");
  const chartTabs = tag("div", "tabs");
  const kltSel = tag("select", "klt");
  const panelRefresh = button("刷新");
  const canvas = tag("canvas", "cv");
  const chartBox = tag("div", "chart");
  chartBox.append(canvas);
  const depthTable = tag("table", "depth");
  let chartKind = "trend";
  let lastPanel = null;
  let lastView = {};
  let autoPicked = false;

  for (const p of KLINE_PERIODS) {
    const opt = tag("option");
    opt.value = String(p.klt);
    opt.textContent = p.label;
    kltSel.append(opt);
  }
  kltSel.onchange = () => ctx.bus.publish(TOPIC_CMD, { action: "klt", value: Number(kltSel.value) });
  panelRefresh.onclick = () => ctx.bus.publish(TOPIC_CMD, { action: "panel" });

  const tabButtons = [];
  for (const [kind, label] of [
    ["trend", "分时"],
    ["kline", "K线"],
  ]) {
    const b = button(label, "tab");
    b.onclick = () => {
      chartKind = kind;
      syncTabs();
      drawChart();
    };
    chartTabs.append(b);
    tabButtons.push([kind, b]);
  }
  function syncTabs() {
    for (const [kind, b] of tabButtons) b.classList.toggle("on", kind === chartKind);
    // 周期选择只在 K 线页有用，分时页留着会让人以为分时也能切周期
    kltSel.style.display = chartKind === "kline" ? "" : "none";
  }
  syncTabs();

  function drawChart() {
    const p = lastPanel;
    // clientWidth 要有值才能定画布位图尺寸；面板刚挂上时可能还没排版，给个兜底宽度
    const cssWidth = canvas.clientWidth || 300;
    const cssHeight = canvas.clientHeight || 132;
    if (chartKind === "kline") {
      drawKline(canvas, p?.kline?.bars, { width: cssWidth, height: cssHeight, dpr: window.devicePixelRatio || 1 });
    } else {
      drawTrend(canvas, p?.trend, { width: cssWidth, height: cssHeight, dpr: window.devicePixelRatio || 1 });
    }
  }

  /** 五档：上卖下买，档位深浅按本侧最大量归一 */
  function renderDepth(p) {
    depthTable.replaceChildren();
    const rows = depthRows(p?.depth);
    if (!rows.asks.length && !rows.bids.length) {
      const tip = tag("td", "muted");
      tip.colSpan = 4;
      tip.textContent = "没有盘口数据（停牌或非交易时段）";
      const tr = tag("tr");
      tr.append(tip);
      depthTable.append(tr);
      return;
    }
    const head = tag("tr");
    for (const h of ["档位", "价格", "手数", ""]) {
      const th = tag("th");
      th.textContent = h;
      head.append(th);
    }
    const thead = tag("thead");
    thead.append(head);
    const body = tag("tbody");
    const mkRow = (r) => {
      const tr = tag("tr", r.side);
      const t1 = tag("td");
      t1.textContent = r.tag;
      const t2 = tag("td");
      t2.textContent = fmtPrice(r.price);
      const t3 = tag("td");
      t3.textContent = Number.isFinite(r.volume) ? String(r.volume) : "—";
      const t4 = tag("td", "bar");
      const bar = tag("span", "w");
      bar.style.width = `${Math.max(2, r.weight)}%`;
      t4.append(bar);
      tr.append(t1, t2, t3, t4);
      return tr;
    };
    for (const r of rows.asks) body.append(mkRow(r));
    const mid = tag("tr", "mid");
    const m1 = tag("td");
    m1.textContent = "现价";
    const m2 = tag("td");
    m2.textContent = fmtPrice(p?.depth?.price);
    const m3 = tag("td", "muted");
    m3.textContent = `均 ${fmtPrice(p?.depth?.avgPrice)}`;
    const m4 = tag("td", "muted");
    m4.textContent = `买/卖 ${rows.totalBid}/${rows.totalAsk}`;
    mid.append(m1, m2, m3, m4);
    body.append(mid);
    for (const r of rows.bids) body.append(mkRow(r));
    depthTable.append(thead, body);
  }

  function renderPanel(p) {
    lastPanel = p ?? null;
    const live = p && !p.cleared && p.secid ? p : null;
    const d = live?.depth;
    if (!live) {
      panelName.textContent = "点下面一行自选股看盘口与曲线";
      panelSub.textContent = "";
      panelErr.textContent = "";
      canvas.style.visibility = "hidden";
      depthTable.replaceChildren();
      return;
    }
    canvas.style.visibility = "";
    panelName.textContent = `${d?.name ?? live.secid}（${d?.code ?? live.secid.slice(2)}）`;
    const pct = Number.isFinite(d?.price) && Number.isFinite(d?.prevClose) && d.prevClose
      ? ((d.price / d.prevClose - 1) * 100)
      : NaN;
    panelSub.textContent =
      `现价 ${fmtPrice(d?.price)} ${fmtPct(pct)} · 昨收 ${fmtPrice(d?.prevClose)} · ` +
      `涨停 ${fmtPrice(d?.limitUp)} / 跌停 ${fmtPrice(d?.limitDown)} · 分时 ${live.trend?.points?.length ?? 0} 点 · K线 ${live.kline?.bars?.length ?? 0} 根`;
    panelSub.className = `muted ${toneOf({ pct })}`;
    panelErr.textContent = live.error ? `盘面数据拉取失败：${live.error}` : "";
    if (Number.isFinite(Number(live.klt))) kltSel.value = String(live.klt);
    drawChart();
    renderDepth(live);
  }

  const panelSection = (() => {
    const hd = tag("div", "panel-hd");
    hd.append(panelName, panelSub);
    const tools = tag("div", "row");
    tools.append(chartTabs, kltSel, panelRefresh);
    const left = tag("div", "chart-col");
    left.append(tools, chartBox, panelErr);
    const right = tag("div", "depth-col");
    right.append(depthTable);
    const grid = tag("div", "panel-grid");
    grid.append(left, right);
    return section("盘面（分时 / K线 / 五档）", hd, grid);
  })();

  wrap.append(
    statusLine,
    (() => {
      const row = tag("div", "row");
      row.append(addInput, searchBtn, addBtn);
      return section("添加自选股", row, sugBox);
    })(),
    section("自选与提醒规则", table, clearBtn),
    panelSection,
    section("显示方式", radios),
    (() => {
      const a = tag("div", "row");
      a.append(text("盘中间隔 "), intervalInput, text("秒 "), intervalBtn, refreshBtn, testBtn);
      const b = tag("div", "checks");
      const l1 = tag("label");
      l1.append(alertsBox, document.createTextNode("系统通知"));
      const l2 = tag("label");
      l2.append(petBox, document.createTextNode("宠物反应"));
      const l3 = tag("label");
      l3.append(showIndexBox, document.createTextNode("带指数"));
      b.append(l1, l2, l3, indexSel);
      return section("刷新与提醒", a, b, netLine);
    })(),
    section("最近提醒", alertList),
  );

  const numCell = (value, placeholder) => {
    const box = input("text", "num");
    box.placeholder = placeholder;
    box.value = typeof value === "number" ? String(value) : "";
    return box;
  };

  const render = (d) => {
    const cfg = d.config ?? {};
    const list = d.watch ?? [];
    lastView = d;

    if (Date.now() - lastStatusAt > 6000) {
      const phase = PHASE_TEXT[d.session?.phase] ?? "";
      const net = d.net ?? {};
      const cool = net.cooldownLeftSec > 0 ? ` · 限流冷却 ${net.cooldownLeftSec}s` : "";
      statusLine.textContent = `${phase} · 盯 ${list.length} 只 · 间隔 ${net.intervalSec ?? cfg.intervalSec ?? "—"}s${cool}${
        d.error ? ` · ${d.error}` : ""
      }`;
      statusLine.className = `status${d.error || net.cooldownLeftSec > 0 ? " error" : ""}`;
      netLine.textContent = `近 1 分钟出网 ${net.window ?? 0} 次（上限 ${net.perMinute ?? "—"}，两次之间至少 ${net.minGapMs ?? "—"}ms）` +
        `${net.noProgress > 0 ? ` · 行情未更新，已退避到 ${net.intervalSec}s` : ""}` +
        `${net.strikes > 0 ? ` · 已被限流 ${net.strikes} 次` : ""}`;
    }

    for (const [value, box] of Object.entries(modeInputs)) box.checked = (cfg.mode ?? "badge") === value;
    if (document.activeElement !== intervalInput) intervalInput.value = String(cfg.intervalSec ?? 20);
    alertsBox.checked = cfg.alertsOn !== false;
    petBox.checked = cfg.petOn !== false;
    showIndexBox.checked = cfg.showIndex !== false;
    if (cfg.indexSecid) indexSel.value = cfg.indexSecid;

    tbody.replaceChildren();
    for (const item of list) {
      const q = d.quotes?.[item.secid];
      const tr = tag("tr");

      const nameTd = tag("td");
      const nm = tag("div");
      nm.textContent = q?.name ?? item.name;
      const code = tag("div", "muted");
      code.textContent = item.code;
      nameTd.append(nm, code);

      const priceTd = tag("td", "quote");
      priceTd.append(text(`${fmtPrice(q?.price)} `), text(fmtPct(q?.pct), toneOf(q)));

      const upper = numCell(item.upper, "涨到");
      const lower = numCell(item.lower, "跌到");
      const pct = numCell(item.pct, "±%");
      const save = button("存");
      save.onclick = () =>
        ctx.bus.publish(TOPIC_CMD, {
          action: "update",
          secid: item.secid,
          upper: upper.value.trim(),
          lower: lower.value.trim(),
          pct: pct.value.trim(),
        });
      const limitBox = input("checkbox");
      limitBox.checked = item.limit !== false;
      limitBox.onchange = () =>
        ctx.bus.publish(TOPIC_CMD, { action: "update", secid: item.secid, limit: limitBox.checked });
      const del = button("删", "danger");
      del.onclick = () => ctx.bus.publish(TOPIC_CMD, { action: "remove", secid: item.secid });

      const ops = tag("td");
      ops.append(save, del);
      const limitTd = tag("td");
      limitTd.append(limitBox);
      tr.append(nameTd, priceTd, cell(upper), cell(lower), cell(pct), limitTd, ops);
      // 整行可点：选中的那只就是盘面面板画的那只。输入框上点的还是输入框，不会误改选中
      tr.classList.add("pick");
      if (lastPanel?.secid === item.secid) tr.classList.add("sel");
      tr.onclick = () => ctx.bus.publish(TOPIC_CMD, { action: "select", secid: item.secid });
      tbody.append(tr);
    }
    if (!list.length) {
      const tr = tag("tr");
      const td = tag("td", "muted");
      td.colSpan = 7;
      td.textContent = "还没有自选股。上面输入代码（如 600519）或名称点「搜索」即可添加。";
      tr.append(td);
      tbody.append(tr);
    }

    alertList.replaceChildren();
    const hits = (d.recent ?? []).filter((a) => a?.message);
    if (!hits.length) {
      const empty = tag("span", "muted");
      empty.textContent = "今天还没有触发过提醒。";
      alertList.append(empty);
    } else {
      for (const a of hits) {
        const row = tag("div");
        row.textContent = `${clockOf(a.at)} · ${a.message}`;
        alertList.append(row);
      }
    }

    // 一进页面就把第一只的盘面拉出来，省得先点一行才知道这块能看什么。
    // 只在本次挂载做一次，避免每轮回显都发一遍 select 去打接口。
    if (!autoPicked && list.length && !lastPanel?.secid) {
      autoPicked = true;
      ctx.bus.publish(TOPIC_CMD, { action: "select", secid: list[0].secid });
    }
  };

  cleanups.push(
    watchView(ctx, render, { beatMs: 60_000 }),
    ctx.bus.subscribe(TOPIC_PANEL, (p) => {
      renderPanel(p);
      render(lastView); // 选中行的高亮跟着面板选的标的走
    }),
    ctx.bus.subscribe(TOPIC_SUGGEST, (p) => {
      suggestions = p?.rows ?? [];
      renderSug();
      setStatus(`搜到 ${suggestions.length} 条结果`, suggestions.length ? "ok" : "error");
    }),
    ctx.bus.subscribe(TOPIC_STATUS, (s) => setStatus(s.text, s.level ?? "info")),
  );

  // 设置窗可以拉伸，画布位图尺寸跟着 CSS 尺寸走，所以要重画一次
  const onResize = () => drawChart();
  window.addEventListener("resize", onResize);
  cleanups.push(() => window.removeEventListener("resize", onResize));

  renderPanel(null);
}

function cell(child) {
  const td = tag("td");
  td.append(child);
  return td;
}

export { PID };
