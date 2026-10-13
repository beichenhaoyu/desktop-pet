// 分节：显示方式 / 刷新与提醒 / 最近提醒（原文件第 3 个横幅，三块都在这一个分节里）。
//   render(d)       —— 状态行 + 出网窗口行 + 各控件回显（statusLine 与 lastStatusAt 走 state.status）
//   renderAlerts(d) —— 最近提醒列表
// 装配关系不在这里：三个 section 节点由 views/settings.js 按原次序 append。

import { sourceLabelOf } from "../../market.js";
import { TOPIC_CMD } from "../../topics.js";
import { button, clockOf, input, PHASE_TEXT, tag, text } from "../dom.js";
import { intervalOf, modeOf, netText, prefChecked, statusText } from "./util.js";

const INDEXES = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
  { secid: "1.000688", name: "科创50" },
  { secid: "1.000300", name: "沪深300" },
];

const MODE_TEXT = { badge: "宠物旁小字", overlay: "桌面左上角盯盘卡", off: "不显示" };

/**
 * 挂「显示方式 / 刷新与提醒 / 最近提醒」三个分节。
 * @param {{bus: {publish: Function}}} ctx
 * @param {any} state 装配壳建的共享状态（用到 status / section，见 work/M4b/closures.md）
 * @returns {{sections: HTMLElement[], render: Function, renderAlerts: Function}}
 *   `sections` 按原 append 次序给出：显示方式 → 刷新与提醒 → 最近提醒。
 */
export function mountPrefs(ctx, state) {
  /* ---------- 显示方式 ---------- */
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

  /* ---------- 刷新与提醒 ---------- */
  const intervalInput = input("text", "num");
  intervalInput.placeholder = "20";
  const intervalBtn = button("应用");
  intervalBtn.onclick = () => {
    const n = Number(intervalInput.value);
    if (!Number.isFinite(n) || n < 10) return state.status.set("间隔至少 10 秒", "error");
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

  const row = tag("div", "row");
  row.append(text("盘中间隔 "), intervalInput, text("秒 "), intervalBtn, refreshBtn, testBtn);
  const checks = tag("div", "checks");
  const l1 = tag("label");
  l1.append(alertsBox, document.createTextNode("系统通知"));
  const l2 = tag("label");
  l2.append(petBox, document.createTextNode("宠物反应"));
  const l3 = tag("label");
  l3.append(showIndexBox, document.createTextNode("带指数"));
  checks.append(l1, l2, l3, indexSel);

  /* ---------- 回灌 ---------- */
  const render = (d) => {
    const cfg = d.config ?? {};
    const list = d.watch ?? [];
    const net = d.net ?? {};

    if (Date.now() - state.status.at > 6000) {
      const line = statusText({
        phaseLabel: PHASE_TEXT[d.session?.phase] ?? "",
        count: list.length,
        net,
        cfgIntervalSec: cfg.intervalSec,
        error: d.error,
      });
      state.status.line.textContent = line.text;
      state.status.line.className = `status${line.error ? " error" : ""}`;
      // 吃的是哪家的数据要看得见（换源是自动的，别让用户以为行情变了口径）。
      // 行情（自选列表快照）与五档各报一句，跟 K线/分时同一个格式
      netLine.textContent = netText(net, sourceLabelOf);
    }

    for (const [value, box] of Object.entries(modeInputs)) box.checked = modeOf(cfg) === value;
    if (document.activeElement !== intervalInput) intervalInput.value = String(intervalOf(cfg));
    alertsBox.checked = prefChecked(cfg.alertsOn);
    petBox.checked = prefChecked(cfg.petOn);
    showIndexBox.checked = prefChecked(cfg.showIndex);
    if (cfg.indexSecid) indexSel.value = cfg.indexSecid;
  };

  const renderAlerts = (d) => {
    alertList.replaceChildren();
    const hits = (d.recent ?? []).filter((a) => a?.message);
    if (!hits.length) {
      const empty = tag("span", "muted");
      empty.textContent = "今天还没有触发过提醒。";
      alertList.append(empty);
    } else {
      for (const a of hits) {
        const rowNode = tag("div");
        rowNode.textContent = `${clockOf(a.at)} · ${a.message}`;
        alertList.append(rowNode);
      }
    }
  };

  return {
    // 次序与原 wrap.append 一致：显示方式 → 刷新与提醒 → 最近提醒
    sections: [state.section("显示方式", radios), state.section("刷新与提醒", row, checks, netLine), state.section("最近提醒", alertList)],
    render,
    renderAlerts,
  };
}
