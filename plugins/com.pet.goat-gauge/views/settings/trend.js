// 趋势：最近 48 小时历史。SVG 只画线与网格，刻度/图例用 HTML span（契约没有 SVG text）。
import { maxValue, polylinePoints } from "../../charts.js";
import { fmtCredits, fmtDateTime, fmtPct } from "../../format.js";
import { card, hint, svg, tag, text } from "../dom.js";

const W = 600;
const H = 160;
const WINDOW_MS = 48 * 60 * 60 * 1000;

function chartSvg(dom, lines) {
  const chart = svg(dom, "svg", {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
    class: "g-chart",
  });
  for (const y of [0, H / 2, H]) {
    chart.append(svg(dom, "line", { x1: 0, y1: y, x2: W, y2: y, class: "g-grid" }));
  }
  const nodes = [];
  for (const cls of lines) {
    const line = svg(dom, "polyline", { points: "", class: `g-line ${cls}` });
    line.dataset.line = cls;
    chart.append(line);
    nodes.push(line);
  }
  return { chart, lines: nodes };
}

function legend(dom, entries) {
  const row = tag(dom, "div", "g-legend");
  const values = {};
  for (const [key, cls, label] of entries) {
    row.append(tag(dom, "i", `g-dot ${cls}`), text(dom, `${label} `));
    const value = text(dom, "—");
    row.append(value);
    values[key] = value;
  }
  return { row, values };
}

export function mountTrend(ctx, state) {
  const dom = ctx.dom;
  const box = card(dom, "最近 48 小时");
  const empty = hint(dom, "还没有足够的历史点（每 5 分钟采样一次）。");

  const pctBox = tag(dom, "div", "g-chart-box");
  const pctLegend = legend(dom, [
    ["five", "five", "5 小时"],
    ["weekly", "weekly", "本周"],
  ]);
  const pct = chartSvg(dom, ["five", "weekly"]);
  const pctRange = text(dom, "", "g-muted");
  pctBox.append(pctLegend.row, pct.chart, pctRange);

  const monthBox = tag(dom, "div", "g-chart-box");
  const monthLegend = legend(dom, [["monthly", "monthly", "本月剩余"]]);
  const month = chartSvg(dom, ["monthly"]);
  const monthRange = text(dom, "", "g-muted");
  monthBox.append(monthLegend.row, month.chart, monthRange);

  box.append(empty, pctBox, monthBox);
  let lastPanel = null;

  function render(panel) {
    lastPanel = panel ?? null;
    const rows = Array.isArray(lastPanel?.history) ? lastPanel.history : [];
    const view = state.lastView ?? {};
    const end = Number(lastPanel?.fetchedAt) || Number(view.fetchedAt) || Date.now();
    const start = end - WINDOW_MS;
    const has = rows.length >= 2;
    empty.className = has ? "g-muted g-hidden" : "g-muted";
    pctBox.className = `g-chart-box${has ? "" : " g-hidden"}`;
    monthBox.className = `g-chart-box${has ? "" : " g-hidden"}`;
    if (!has) return;

    pct.lines[0].setAttribute(
      "points",
      polylinePoints(rows, 1, { width: W, height: H, start, end, min: 0, max: 100 }),
    );
    pct.lines[1].setAttribute(
      "points",
      polylinePoints(rows, 2, { width: W, height: H, start, end, min: 0, max: 100 }),
    );
    const cap = Number(view.plan?.monthly_credits);
    const monthlyMax = cap > 0 ? cap : maxValue(rows, 3, 70);
    month.lines[0].setAttribute(
      "points",
      polylinePoints(rows, 3, { width: W, height: H, start, end, min: 0, max: monthlyMax }),
    );

    pctRange.textContent = `${fmtDateTime(start)} → ${fmtDateTime(end)}（上限 100%）`;
    monthRange.textContent = `0 – ${fmtCredits(monthlyMax)} credits · ${fmtDateTime(start)} → ${fmtDateTime(end)}`;
    pctLegend.values.five.textContent = fmtPct(view.windows?.five_hour?.remaining_pct);
    pctLegend.values.weekly.textContent = fmtPct(view.windows?.weekly?.remaining_pct);
    monthLegend.values.monthly.textContent = fmtCredits(view.windows?.monthly?.remaining);
  }

  return { box, render, last: () => lastPanel };
}
