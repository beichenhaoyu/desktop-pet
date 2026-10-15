// Widget 三个区域共用的小件：样式注入、元素构造、行情格式化。

/* ================= 共用小工具 ================= */
// Worker 路线里没有 document，建节点统一从 `ctx.dom` 走。dom 由调用方逐层传入，
// **不用模块级变量存它** —— 同一份文件同时挂在 badge / overlay / settings 三个区，
// 模块级状态会让三个实例互相指错。
export function addStyle(dom, root, css) {
  const node = dom.createElement("style");
  node.textContent = css;
  root.append(node);
}
export function tag(dom, name, cls) {
  const node = dom.createElement(name);
  if (cls) node.className = cls;
  return node;
}
export function text(dom, content, cls) {
  const node = tag(dom, "span", cls);
  node.textContent = String(content ?? "");
  return node;
}
export function button(dom, label, cls) {
  const node = tag(dom, "button", cls);
  node.type = "button";
  node.textContent = label;
  return node;
}
export function input(dom, type, cls) {
  const node = tag(dom, "input", cls);
  node.type = type;
  return node;
}
/** A股习惯：红涨绿跌。数值缺失（停牌/未开盘）走灰色，不显示 NaN */
export function toneOf(q) {
  const pct = q?.pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "flat";
  return pct > 0 ? "up" : pct < 0 ? "down" : "flat";
}
export function fmtPrice(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";
}
export function fmtPct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
export function clockOf(ms) {
  return typeof ms === "number"
    ? new Date(ms).toLocaleTimeString("zh-CN", { hour12: false })
    : "";
}
export const PHASE_TEXT = {
  pre: "开盘前",
  auction: "集合竞价",
  morning: "上午盘中",
  lunch: "午间休市",
  afternoon: "下午盘中",
  closed: "已收盘",
  weekend: "周末休市",
};
export function cell(dom, child) {
  const td = tag(dom, "td");
  td.append(child);
  return td;
}
