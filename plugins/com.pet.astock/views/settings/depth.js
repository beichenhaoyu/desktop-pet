// 分节：五档（上卖下买）。原位是 mountSettings 里的 renderDepth 闭包，只依赖深度表这个 DOM 节点。
// 跨节通信单向：本模块把 render 挂到 state.depth 上，盘面分节（board.js）调它 —— 兄弟模块之间不 import。

import { depthRows } from "../../charts.js";
import { fmtPrice, tag } from "../dom.js";
import { barWidthPct } from "./util.js";

/**
 * 建五档表并把它的渲染挂到 state.depth（返回表节点给装配壳放进盘面分节右列）。
 * @param {any} _ctx 本分节不问宿主任何事；签名与其它分节一致（装配壳一视同仁地按 (ctx, state) 调），
 *   下划线是 Biome `noUnusedFunctionParameters` 认可的「有意不用」写法
 * @param {any} state 装配壳建的共享状态（字段清单见 work/M4b/closures.md）
 * @returns {HTMLElement} 深度表节点
 */
export function mountDepth(_ctx, state) {
  const depthTable = tag("table", "depth");

  /** 五档：上卖下买，档位深浅按本侧最大量归一 */
  function render(p) {
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
      bar.style.width = `${barWidthPct(r.weight)}%`;
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

  state.depth = { table: depthTable, render };
  return depthTable;
}
