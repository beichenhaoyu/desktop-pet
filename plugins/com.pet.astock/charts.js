// 画布层：分时图与 K 线图，纯 Canvas2D，不引第三方库。
//
// 为什么自己画：widget 跑在 closed Shadow DOM 里，宿主 CSP 的 script-src 只放行
// petplugin 协议，塞一个打包好的图表库进来换来的收益不值当；这两张图需要的东西
// （折线 + 蜡烛 + 量能 + 网格）手写一百多行就够，而且几何完全可控、能直接断言。
//
// 这里的函数都不碰网络也不碰 DOM 树，只接 canvas 和数据，回归脚本可以拿
// getImageData 数非背景像素来证明「真的画出了东西」，而不是只看它没报错。

const COLORS = {
  bg: "#11131a",
  grid: "rgba(255,255,255,.10)",
  axis: "#9aa3b2",
  up: "#ff6b6b",
  down: "#4ade80",
  flat: "#cbd2dc",
  avg: "#f5c518",
  preClose: "rgba(255,255,255,.35)",
  ma: ["#f5c518", "#4da3ff", "#c58cff"],
};

// 左侧留白要装得下「1265.03」这种七字刻度（10px 字体约 40px），窄了会被画布裁掉左半边
const PAD = { left: 56, right: 8, top: 10, bottom: 14 };
/** 分时一天的采样槽位数：9:30–11:30 + 13:00–15:00 = 242 分钟。
 *  横轴按固定槽位铺而不是按已有样条数，盘中才会留白而不是把半天拉伸成全天。 */
const TREND_SLOTS = 242;
const VOLUME_RATIO = 0.22;

/**
 * 按 CSS 尺寸与设备像素比准备好画布。
 * DPR 变了要重设 width/height（Canvas 的位图尺寸改了就清空内容），所以每次重绘都调它。
 */
export function prepareCanvas(canvas, cssWidth, cssHeight, dpr = 1) {
  const scale = Math.max(1, Math.min(3, dpr || 1));
  const w = Math.max(1, Math.round(cssWidth * scale));
  const h = Math.max(1, Math.round(cssHeight * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext("2d");
  g.setTransform(scale, 0, 0, scale, 0, 0);
  return { g, width: cssWidth, height: cssHeight };
}

function fillBackground(g, width, height) {
  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, width, height);
}

function label(g, text, x, y, { align = "left", color = COLORS.axis, baseline = "middle" } = {}) {
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = baseline;
  g.fillText(text, x, y);
}

function emptyNotice(g, width, height, text) {
  fillBackground(g, width, height);
  g.font = "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  label(g, text, width / 2, height / 2, { align: "center", color: COLORS.axis });
}

function fmtPrice(v) {
  return Number.isFinite(v) ? v.toFixed(Math.abs(v) < 10 ? 3 : 2) : "-";
}

function fmtVolume(v) {
  if (!Number.isFinite(v)) return "-";
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(Math.round(v));
}

/**
 * 网格 + 左侧价格刻度 + 底部时刻。
 * yLabels 必须是**已经格式化好的字符串**：直接把浮点喂给 fillText 会画出
 * 「1246.999999997」这种尾巴（实测打包版截图就是），既难看又被裁切。
 */
function drawFrame(g, box, yLabels, xLabels, labelY) {
  g.strokeStyle = COLORS.grid;
  g.lineWidth = 1;
  g.font = "10px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  const rows = yLabels.length - 1;
  for (let i = 0; i <= rows; i++) {
    const y = Math.round(box.y + (box.h * i) / rows) + 0.5;
    g.beginPath();
    g.moveTo(box.x, y);
    g.lineTo(box.x + box.w, y);
    g.stroke();
    label(g, yLabels[rows - i], box.x - 5, y, { align: "right" });
  }
  for (const { text, at } of xLabels) {
    const x = Math.round(box.x + box.w * at) + 0.5;
    g.beginPath();
    g.moveTo(x, box.y);
    g.lineTo(x, box.y + box.h);
    g.stroke();
    label(g, text, x, labelY, { align: "center" });
  }
}

/**
 * 分时图：价格折线 + 均价虚线 + 昨收基准线 + 底部量能。
 * 纵轴按「昨收」上下对称取范围，这样中线就是平盘，涨跌一眼能看出来。
 */
export function drawTrend(canvas, data, { width = 300, height = 132, dpr = 1 } = {}) {
  const { g, width: w, height: h } = prepareCanvas(canvas, width, height, dpr);
  fillBackground(g, w, h);
  const points = data?.points ?? [];
  if (points.length < 1) {
    emptyNotice(g, w, h, "还没有分时数据");
    return { drawn: false, reason: "no points" };
  }

  const preClose = Number.isFinite(data?.preClose) ? data.preClose : points[0].price;
  const volH = Math.round(h * VOLUME_RATIO);
  const box = { x: PAD.left, y: PAD.top, w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom - volH - 6 };
  const vol = { x: box.x, y: box.y + box.h + 6, w: box.w, h: volH - 10 };
  const labelY = h - 5; // 时刻放在量能条下面，别和它叠在一起（实测截图里两者重合过）

  // 对称范围：取偏离昨收最大幅度的点，再留 5% 余量，避免贴边
  let span = 0;
  for (const p of points) {
    if (Number.isFinite(p.price)) span = Math.max(span, Math.abs(p.price - preClose));
    if (Number.isFinite(p.avg)) span = Math.max(span, Math.abs(p.avg - preClose));
  }
  span = span || preClose * 0.01 || 1;
  const hi = preClose + span * 1.05;
  const lo = preClose - span * 1.05;
  const yOf = (v) => box.y + ((hi - v) / (hi - lo)) * box.h;
  const xOf = (i) => box.x + (i / (TREND_SLOTS - 1)) * box.w;

  g.font = "10px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  const xLabels = [{ text: points[0].time, at: 0 }, { text: "午", at: 0.5 }];
  const lastAt = (points.length - 1) / (TREND_SLOTS - 1);
  // 采样点少的时候（竞价、刚开盘）末点会贴着起点，两个时刻叠成「09:3009:42」，宁可不画
  if (points.length > 1 && lastAt > 0.1) xLabels.push({ text: points.at(-1).time, at: lastAt });
  drawFrame(g, box, [fmtPrice(lo), fmtPrice((lo + hi) / 2), fmtPrice(hi)], xLabels, labelY);

  // 昨收基准线（平盘位）
  g.strokeStyle = COLORS.preClose;
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(box.x, Math.round(yOf(preClose)) + 0.5);
  g.lineTo(box.x + box.w, Math.round(yOf(preClose)) + 0.5);
  g.stroke();
  g.setLineDash([]);

  // 价格线：在昨收上方用红、下方用绿，得填两段渐变太啰嗦，这里按首末整体判一次色
  const last = points.at(-1);
  const tone = last.price >= preClose ? COLORS.up : COLORS.down;
  g.strokeStyle = tone;
  g.lineWidth = 1.4;
  g.beginPath();
  points.forEach((p, i) => {
    const x = xOf(i);
    const y = yOf(p.price);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  });
  g.stroke();
  // 竞价阶段只有一个采样点，折线画不出长度，落一个点表示「有数了」
  if (points.length === 1) {
    g.fillStyle = tone;
    g.beginPath();
    g.arc(xOf(0), yOf(points[0].price), 2.6, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = COLORS.avg;
  g.lineWidth = 1;
  g.beginPath();
  let started = false;
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i].avg)) continue;
    const x = xOf(i);
    const y = yOf(points[i].avg);
    started ? g.lineTo(x, y) : (g.moveTo(x, y), (started = true));
  }
  g.stroke();

  // 量能：按分钟量画柱，最大量归一到区域高度
  const maxVol = Math.max(...points.map((p) => (Number.isFinite(p.volume) ? p.volume : 0)), 1);
  points.forEach((p, i) => {
    const v = Number.isFinite(p.volume) ? p.volume : 0;
    const bh = (v / maxVol) * vol.h;
    g.fillStyle = p.price >= preClose ? COLORS.up : COLORS.down;
    g.globalAlpha = 0.55;
    g.fillRect(xOf(i), vol.y + vol.h - bh, Math.max(1, box.w / TREND_SLOTS), bh);
  });
  g.globalAlpha = 1;

  label(g, fmtVolume(maxVol) + "手", vol.x + 2, vol.y + 6, { align: "left" });
  return { drawn: true, points: points.length, tone };
}

/** 移动平均（收盘价），返回与 bars 等长、前段为 null 的数组 */
export function movingAverage(bars, span) {
  const out = new Array(bars.length).fill(null);
  if (!(span > 0) || bars.length < span) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= span) sum -= bars[i - span].close;
    if (i >= span - 1) out[i] = sum / span;
  }
  return out;
}

/**
 * K 线图：蜡烛 + 上下影线 + MA5/10/20 + 底部量能。
 * 横轴按根数铺（不像分时那样固定槽位），一屏就是最近这些根。
 */
export function drawKline(canvas, bars, { width = 300, height = 132, dpr = 1 } = {}) {
  const { g, width: w, height: h } = prepareCanvas(canvas, width, height, dpr);
  fillBackground(g, w, h);
  const list = bars ?? [];
  if (list.length < 2) {
    emptyNotice(g, w, h, "还没有 K 线数据");
    return { drawn: false, reason: "bars<2" };
  }

  const volH = Math.round(h * VOLUME_RATIO);
  const box = { x: PAD.left, y: PAD.top, w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom - volH - 6 };
  const vol = { x: box.x, y: box.y + box.h + 6, w: box.w, h: volH - 10 };
  const labelY = h - 5; // 时刻放在量能条下面，别和它叠在一起（实测截图里两者重合过）

  let hi = -Infinity;
  let lo = Infinity;
  for (const b of list) {
    if (Number.isFinite(b.high)) hi = Math.max(hi, b.high);
    if (Number.isFinite(b.low)) lo = Math.min(lo, b.low);
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) {
    hi = list.at(-1).close * 1.01;
    lo = list.at(-1).close * 0.99;
  }
  const pad = (hi - lo) * 0.06;
  hi += pad;
  lo -= pad;

  const step = box.w / list.length;
  const xOf = (i) => box.x + step * (i + 0.5);
  const yOf = (v) => box.y + ((hi - v) / (hi - lo)) * box.h;

  g.font = "10px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  drawFrame(g, box, [fmtPrice(lo), fmtPrice((lo + hi) / 2), fmtPrice(hi)], [
    { text: list[0].time.slice(5), at: 0.02 },
    { text: list[Math.floor(list.length / 2)].time.slice(5), at: 0.5 },
    { text: list.at(-1).time.slice(5), at: 0.98 },
  ], labelY);

  const bodyW = Math.max(1.5, Math.min(9, step * 0.62));
  list.forEach((b, i) => {
    const up = b.close >= b.open;
    const color = up ? COLORS.up : COLORS.down;
    const x = xOf(i);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, yOf(b.high));
    g.lineTo(Math.round(x) + 0.5, yOf(b.low));
    g.stroke();
    const top = yOf(Math.max(b.open, b.close));
    const bh = Math.max(1, Math.abs(yOf(b.open) - yOf(b.close)));
    g.fillStyle = color;
    g.fillRect(x - bodyW / 2, top, bodyW, bh);
  });

  for (let m = 0; m < 3; m++) {
    const span = [5, 10, 20][m];
    const ma = movingAverage(list, span);
    g.strokeStyle = COLORS.ma[m];
    g.lineWidth = 1;
    g.beginPath();
    let started = false;
    for (let i = 0; i < list.length; i++) {
      if (ma[i] === null) continue;
      const x = xOf(i);
      const y = yOf(ma[i]);
      started ? g.lineTo(x, y) : (g.moveTo(x, y), (started = true));
    }
    if (started) g.stroke();
  }

  const maxVol = Math.max(...list.map((b) => (Number.isFinite(b.volume) ? b.volume : 0)), 1);
  list.forEach((b, i) => {
    const v = Number.isFinite(b.volume) ? b.volume : 0;
    const bh = (v / maxVol) * vol.h;
    g.fillStyle = b.close >= b.open ? COLORS.up : COLORS.down;
    g.globalAlpha = 0.55;
    g.fillRect(xOf(i) - bodyW / 2, vol.y + vol.h - bh, bodyW, bh);
  });
  g.globalAlpha = 1;

  const last = list.at(-1);
  label(g, fmtPrice(last.close), box.x - 4, yOf(last.close), {
    align: "right",
    color: last.close >= last.open ? COLORS.up : COLORS.down,
  });
  return { drawn: true, bars: list.length, last: last.close };
}

/**
 * 五档盘口：把接口给的「卖一到卖五 / 买一到买五」摊成界面要的排布
 * （上面卖盘从卖五到卖一递减、中间现价、下面买盘从买一到买五递增）。
 * 纯数据变换，界面层只管把数字写进 textContent。
 */
export function depthRows(depth) {
  if (!depth) return { asks: [], bids: [] };
  const sum = (rows) => rows.reduce((acc, r) => acc + (Number.isFinite(r.volume) ? r.volume : 0), 0);
  const maxVol = Math.max(...depth.asks.map((r) => r.volume ?? 0), ...depth.bids.map((r) => r.volume ?? 0), 1);
  const decorate = (rows, side) =>
    rows.map((r, i) => ({
      side,
      tag: `${side === "ask" ? "卖" : "买"}${i + 1}`,
      price: r.price,
      volume: r.volume,
      /** 占比用于画那根深浅条，100% 是**买卖两侧合并**里最大的那一档（两侧能横向比较才有意义） */
      weight: Math.round(((r.volume ?? 0) / maxVol) * 100),
    }));
  return {
    asks: decorate(depth.asks, "ask").reverse(),
    bids: decorate(depth.bids, "bid"),
    totalAsk: sum(depth.asks),
    totalBid: sum(depth.bids),
    limitUp: depth.limitUp,
    limitDown: depth.limitDown,
  };
}

export { COLORS };
