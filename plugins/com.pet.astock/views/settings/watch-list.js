// 分节：自选列表与阈值（表格 + 两步清空），以及这份表格的两种回灌：
//   render(d)   —— 写 tbody（行高亮跟着 state.lastPanel）
//   autoPick(d) —— 首次进页面自动选中第一只（只做一次，别每轮回显都打一次接口）
// 装配关系不在这里：views/settings.js 按顺序挂分节并决定两者的调用次序，跨节共享只走 state。

import { TOPIC_CMD } from "../../topics.js";
import { button, cell, fmtPct, fmtPrice, input, tag, text, toneOf } from "../dom.js";

const HEADS = ["名称", "现价 / 涨跌", "涨到", "跌到", "±%", "停", ""];

/** 阈值输入框：数值回显，空着表示未设（`typeof value === "number"` 的判定不动，字符串一律当没给） */
const numCell = (value, placeholder) => {
  const box = input("text", "num");
  box.placeholder = placeholder;
  box.value = typeof value === "number" ? String(value) : "";
  return box;
};

/**
 * 挂「自选与提醒规则」分节。
 * @param {{bus: {publish: Function}}} ctx
 * @param {any} state 装配壳建的共享状态（用到 lastPanel / autoPicked / section，见 work/M4b/closures.md）
 * @returns {{section: HTMLElement, render: Function, autoPick: Function}}
 */
export function mountWatchList(ctx, state) {
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

  const render = (d) => {
    const list = d.watch ?? [];
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
      if (state.lastPanel?.secid === item.secid) tr.classList.add("sel");
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
  };

  // 一进页面就把第一只的盘面拉出来，省得先点一行才知道这块能看什么。
  // 只在本次挂载做一次，避免每轮回显都发一遍 select 去打接口。
  const autoPick = (d) => {
    const list = d.watch ?? [];
    if (!state.autoPicked && list.length && !state.lastPanel?.secid) {
      state.autoPicked = true;
      ctx.bus.publish(TOPIC_CMD, { action: "select", secid: list[0].secid });
    }
  };

  return { section: state.section("自选与提醒规则", table, clearBtn), render, autoPick };
}
