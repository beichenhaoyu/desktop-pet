// 分节：选中个股的盘面（分时 / K线 / 五档）—— 面板头、分时/K线切换、周期下拉、画布。
// 五档表本体在 depth.js（它自己挂 state.depth.render），本模块只把它放进右列并在回灌时调它。
// 跨节共享只走 state：lastPanel（选中标的，自选列表拿它做行高亮）、lastView（涨跌停那一路的回落）、depth。

import { drawKline, drawTrend } from "../../charts.js";
import { KLINE_PERIODS, sourceLabelOf } from "../../market.js";
import { TOPIC_CMD } from "../../topics.js";
import { button, fmtPct, fmtPrice, tag, text, toneOf } from "../dom.js";
import { kltDisplay, kltOptionValue, pickLimit, rawPctOf } from "./util.js";

/**
 * 挂「盘面」分节。
 * @param {{bus: {publish: Function}}} ctx
 * @param {any} state 装配壳建的共享状态（用到 lastView / lastPanel / depth / section，见 work/M4b/closures.md）
 * @returns {{section: HTMLElement, renderPanel: Function, drawChart: Function}}
 */
export function mountBoard(ctx, state) {
  const panelName = text("点下面一行自选股看盘口与曲线", "nm");
  const panelSub = text("", "muted");
  const panelErr = text("", "muted");
  const chartTabs = tag("div", "tabs");
  const kltSel = tag("select", "klt");
  const panelRefresh = button("刷新");
  const canvas = tag("canvas", "cv");
  const chartBox = tag("div", "chart");
  chartBox.append(canvas);
  let chartKind = "trend";

  for (const p of KLINE_PERIODS) {
    const opt = tag("option");
    opt.value = kltOptionValue(p);
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
    kltSel.style.display = kltDisplay(chartKind);
  }
  syncTabs();

  function drawChart() {
    const p = state.lastPanel;
    // clientWidth 要有值才能定画布位图尺寸；面板刚挂上时可能还没排版，给个兜底宽度
    const cssWidth = canvas.clientWidth || 300;
    const cssHeight = canvas.clientHeight || 132;
    if (chartKind === "kline") {
      drawKline(canvas, p?.kline?.bars, { width: cssWidth, height: cssHeight, dpr: window.devicePixelRatio || 1 });
    } else {
      drawTrend(canvas, p?.trend, { width: cssWidth, height: cssHeight, dpr: window.devicePixelRatio || 1 });
    }
  }

  function renderPanel(p) {
    state.lastPanel = p ?? null;
    const live = p && !p.cleared && p.secid ? p : null;
    const d = live?.depth;
    if (!live) {
      panelName.textContent = "点下面一行自选股看盘口与曲线";
      panelSub.textContent = "";
      panelErr.textContent = "";
      canvas.style.visibility = "hidden";
      state.depth.table.replaceChildren();
      return;
    }
    canvas.style.visibility = "";
    panelName.textContent = `${d?.name ?? live.secid}（${d?.code ?? live.secid.slice(2)}）`;
    const pct = rawPctOf(d?.price, d?.prevClose);
    // 涨停/跌停优先用五档那一路（腾讯段 47/48、东财 f51/f52 都是交易所给的价），
    // 它没给就退回快照那一路；两路都没有就明写「该源不供」—— 不拿按代码前缀猜的幅度冒充交易所的价
    const q = state.lastView?.quotes?.[live.secid] ?? null;
    const limitUp = pickLimit(d?.limitUp, q?.limitUp);
    const limitDown = pickLimit(d?.limitDown, q?.limitDown);
    const limitText =
      limitUp === null && limitDown === null
        ? `涨停/跌停 该源不供（${sourceLabelOf(live.depthSource || state.lastView?.net?.sources?.quote || "") || "未知来源"}）`
        : `涨停 ${fmtPrice(limitUp)} / 跌停 ${fmtPrice(limitDown)}`;
    panelSub.textContent =
      `现价 ${fmtPrice(d?.price)} ${fmtPct(pct)} · 昨收 ${fmtPrice(d?.prevClose)} · ` +
      `${limitText} · 分时 ${live.trend?.points?.length ?? 0} 点 · K线 ${live.kline?.bars?.length ?? 0} 根`;
    panelSub.className = `muted ${toneOf({ pct })}`;
    panelErr.textContent = live.error ? `盘面数据拉取失败：${live.error}` : "";
    if (Number.isFinite(Number(live.klt))) kltSel.value = String(live.klt);
    drawChart();
    state.depth.render(live);
  }

  const hd = tag("div", "panel-hd");
  hd.append(panelName, panelSub);
  const tools = tag("div", "row");
  tools.append(chartTabs, kltSel, panelRefresh);
  const left = tag("div", "chart-col");
  left.append(tools, chartBox, panelErr);
  const right = tag("div", "depth-col");
  right.append(state.depth.table);
  const grid = tag("div", "panel-grid");
  grid.append(left, right);

  return { section: state.section("盘面（分时 / K线 / 五档）", hd, grid), renderPanel, drawChart };
}
