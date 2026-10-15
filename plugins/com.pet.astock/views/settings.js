// settings：插件页的**装配壳**（分节在 views/settings/ 下，M4b 拆分）。
// 本文件只做三件事，页面结构一律不在这里：
//   1) 建共享状态对象 `state`（DOM 句柄 + 跨节状态 + 各分节挂上来的回调）
//   2) 把各分节按**原 append 次序**接起来
//   3) 把订阅与监听注册进 cleanups
// 导出面与拆分前一字不差：`export function mountSettings(root, ctx, cleanups)`。

import { TOPIC_PANEL, TOPIC_SUGGEST, TOPIC_STATUS } from "../topics.js";
import { addStyle, tag } from "./dom.js";
import { mountAdd } from "./settings/add.js";
import { mountBoard } from "./settings/board.js";
import { mountDepth } from "./settings/depth.js";
import { mountPrefs } from "./settings/prefs.js";
import { SETTINGS_CSS } from "./settings/util.js";
import { mountWatchList } from "./settings/watch-list.js";
import { watchView } from "./watch.js";

export function mountSettings(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(dom, root, SETTINGS_CSS);

  const wrap = tag(dom, "div", "wrap");
  root.append(wrap);

  // 用户刚操作过 → 状态行保留操作结果几秒，不被下一轮回显盖掉
  const statusLine = tag(dom, "div", "status");
  const status = {
    at: 0,
    line: statusLine,
    set: (t, level = "info") => {
      status.at = Date.now();
      statusLine.textContent = t;
      statusLine.className = `status${level === "info" ? "" : ` ${level}`}`;
    },
  };
  statusLine.textContent = "正在读取当前配置…";

  const state = {
    status, // 状态行（分节要写操作结果）
    lastView: {}, // 最近一份 *:widget 数据（盘面分节拿它回落涨跌停）
    lastPanel: null, // 当前选中的盘面（自选分节拿它做行高亮）
    autoPicked: false, // 首次自动选中只做一次
    /** 分节外壳：标题 + 内容节点（A/B/C/D 四节都在用，所以只能由壳提供） */
    section: (title, ...nodes) => {
      const box = tag(dom, "div", "sec");
      const t = tag(dom, "div", "sec-t");
      t.textContent = title;
      box.append(t, ...nodes);
      return box;
    },
  };

  const add = mountAdd(ctx, state);
  const watchList = mountWatchList(ctx, state);
  const prefs = mountPrefs(ctx, state);
  mountDepth(ctx, state); // 先于 board：盘面分节要把深度表的节点放进右列
  const board = mountBoard(ctx, state, cleanups);

  wrap.append(statusLine, add.section, watchList.section, board.section, ...prefs.sections);

  // 回灌：原 render 的三段（状态与配置 → 自选表 → 最近提醒 → 首次自动选中）按原次序调，
  // 每段只碰自己那节，跨节的部分从 state 读。
  const render = (d) => {
    state.lastView = d;
    prefs.render(d);
    watchList.render(d);
    prefs.renderAlerts(d);
    watchList.autoPick(d);
  };

  cleanups.push(
    watchView(ctx, render, { beatMs: 60_000 }),
    ctx.bus.subscribe(TOPIC_PANEL, (p) => {
      board.renderPanel(p);
      render(state.lastView); // 选中行的高亮跟着面板选的标的走
    }),
    ctx.bus.subscribe(TOPIC_SUGGEST, (p) => {
      const n = add.setSuggestions(p?.rows ?? []);
      status.set(`搜到 ${n} 条结果`, n ? "ok" : "error");
    }),
    ctx.bus.subscribe(TOPIC_STATUS, (s) => status.set(s.text, s.level ?? "info")),
  );

  // 设置窗可以拉伸：尺寸 / dpr / 画布量得的宽高由宿主观测后推（替代原来的 window resize），
  // 每次推送都按最新 layout 重画一次
  cleanups.push(ctx.onLayout((layout) => board.drawChart(layout)));

  board.renderPanel(null);
}
