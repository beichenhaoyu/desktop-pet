// 分节：添加自选（关键字搜索候选 + 直接按代码添加）。
// 装配关系不在这里：views/settings.js 按顺序挂分节，跨节共享只走 state 与 ./util.js。

import { TOPIC_CMD } from "../../topics.js";
import { button, input, tag, text } from "../dom.js";

/**
 * 挂「添加自选」分节。
 * @param {{bus: {publish: Function}}} ctx 插件上下文（只用 bus）
 * @param {any} state 装配壳建的共享状态（字段清单见 work/M4b/closures.md）
 * @returns {{section: HTMLElement, setSuggestions: (rows: unknown[]) => number}}
 *   `setSuggestions` 返回候选条数，供壳里的订阅写状态行（原来是在同处读 `suggestions.length`）。
 */
export function mountAdd(ctx, state) {
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
    if (!kw) return state.status.set("先输入代码或名称关键字", "error");
    state.status.set(`正在搜索「${kw}」…`);
    ctx.bus.publish(TOPIC_CMD, { action: "search", keyword: kw });
  };
  addBtn.onclick = () => {
    const v = addInput.value.trim();
    if (!v) return state.status.set("先输入 6 位代码", "error");
    ctx.bus.publish(TOPIC_CMD, { action: "add", input: v });
    addInput.value = "";
  };
  addInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBtn.click();
    }
  };

  const row = tag("div", "row");
  row.append(addInput, searchBtn, addBtn);

  return {
    section: state.section("添加自选股", row, sugBox),
    setSuggestions: (rows) => {
      suggestions = rows;
      renderSug();
      return suggestions.length;
    },
  };
}
