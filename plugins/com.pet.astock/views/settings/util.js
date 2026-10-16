// settings/ 分节模块共用的**纯**口径：无 DOM、无 ctx、无 import（卡片 §6 允许的唯一共享模块）。
//
// 为什么单独一份：装配壳（views/settings.js）之外，分节模块之间不许互相 import，
// 跨节共用的东西必须落在唯一一处。这里只放能脱离 DOM 判定的计算 + 页面级样式串
// （样式五个分节共用，而壳文件有 4096 字节上限，放壳里会超；它是惰性字符串，不碰 DOM）。
// 界面构建仍在各分节里；unit-astock-views.mjs 直接 import 本文件钉这些口径。

/** 插件页样式。五个分节共用一份（原 mountSettings 顶部那段 addStyle 的原文） */
export const SETTINGS_CSS = `
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
    `;

/**
 * 现价相对昨收的涨跌幅（%）—— **原始值，不四舍五入**。
 * 与 market.js 的 `pctOf` 不是一回事：那个会 round 到两位小数、缺值给 null，
 * 这里要的是能直接喂 `fmtPct` 的裸比例（面板副标题就这么显示）。
 * 缺任一项或昨收为 0 → NaN（不猜幅度）。
 */
export function rawPctOf(price, prevClose) {
  return Number.isFinite(price) && Number.isFinite(prevClose) && prevClose ? (price / prevClose - 1) * 100 : NaN;
}

/** 涨停/跌停价取值：优先五档那一路（交易所给的价），再退快照那一路，都没有给 null */
export function pickLimit(primary, fallback) {
  return Number.isFinite(primary) ? primary : Number.isFinite(fallback) ? fallback : null;
}

/** 档位深浅条宽度（%）：最小 2% 也要看得见（原 renderDepth 里的 Math.max(2, …)） */
export function barWidthPct(weight) {
  return Math.max(2, weight);
}

/** 配置回显：mode 缺省是 badge */
export function modeOf(cfg) {
  return cfg?.mode ?? "badge";
}

/** 配置回显：间隔缺省 20 秒 */
export function intervalOf(cfg) {
  return cfg?.intervalSec ?? 20;
}

/** 配置回显：盯盘卡 X 坐标缺省 420（与 main.js DEFAULT_CONFIG 同值） */
export function cardXOf(cfg) {
  return cfg?.cardX ?? 420;
}

/** 配置回显：盯盘卡 Y 坐标缺省 180（缺省非对称是故意的：对称点抓不到 x/y 对调的错） */
export function cardYOf(cfg) {
  return cfg?.cardY ?? 180;
}

/** 配置回显：勾选项「没显式关掉就是开着」（alertsOn / petOn / showIndex 同一个口径） */
export function prefChecked(value) {
  return value !== false;
}

/** K 线周期下拉的 option.value：select 的比较按字符串走 */
export function kltOptionValue(period) {
  return String(period.klt);
}

/** 周期选择只在 K 线页有用，分时页留着会让人以为分时也能切周期 → 返回 display 值 */
export function kltDisplay(chartKind) {
  return chartKind === "kline" ? "" : "none";
}

/**
 * 状态行文案 + 是否按错误色显示（phaseLabel 由调用方从 PHASE_TEXT 取好再传，本模块不碰 DOM 常量）。
 * 口径照原 render 里的状态块：限流冷却与 error 都算「异常色」，但只有非零冷却才进文案。
 */
export function statusText({ phaseLabel, count, net, cfgIntervalSec, error }) {
  const n = net ?? {};
  const cool = n.cooldownLeftSec > 0 ? ` · 限流冷却 ${n.cooldownLeftSec}s` : "";
  const text = `${phaseLabel ?? ""} · 盯 ${count} 只 · 间隔 ${n.intervalSec ?? cfgIntervalSec ?? "—"}s${cool}${
    error ? ` · ${error}` : ""
  }`;
  return { text, error: Boolean(error) || n.cooldownLeftSec > 0 };
}

/**
 * 出网窗口那一行：窗口次数 / 上限 / 最小间隔 + 退避与限流 + 各路数据源。
 * `labelOf` 由调用方传（市场层的 sourceLabelOf），本模块不认识源注册表。
 */
export function netText(net, labelOf = (id) => id) {
  const n = net ?? {};
  const src = n.sources ?? {};
  const parts = [];
  if (src.quote) parts.push(`行情数据源 ${labelOf(src.quote)}`);
  if (src.depth && src.depth !== src.quote) parts.push(`五档数据源 ${labelOf(src.depth)}`);
  if (src.kline) parts.push(`K线数据源 ${labelOf(src.kline)}`);
  if (src.trend && src.trend !== src.kline) parts.push(`分时数据源 ${labelOf(src.trend)}`);
  return (
    `近 1 分钟出网 ${n.window ?? 0} 次（上限 ${n.perMinute ?? "—"}，两次之间至少 ${n.minGapMs ?? "—"}ms）` +
    `${n.noProgress > 0 ? ` · 行情未更新，已退避到 ${n.intervalSec}s` : ""}` +
    `${n.strikes > 0 ? ` · 已被限流 ${n.strikes} 次` : ""}` +
    `${parts.length ? ` · ${parts.join(" · ")}` : ""}`
  );
}
