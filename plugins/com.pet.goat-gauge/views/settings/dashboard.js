// 概览：账户/套餐、三环、KPI、告警、刷新与网络状态。
import { fmtCredits, fmtDateTime, fmtMoney, fmtPct, fmtTokens } from "../../format.js";
import { TOPIC_CMD } from "../../topics.js";
import { button, card, hint, row, tag, text } from "../dom.js";
import { createRing } from "../rings.js";

const KPI_DEFS = [
  ["monthly", "月剩余"],
  ["purchased", "购买"],
  ["free", "赠送"],
  ["requests", "请求数"],
  ["cost", "总成本"],
  ["avg", "平均成本"],
  ["success", "成功率"],
  ["tokens", "Tokens (入/出)"],
];

const STATUS_TEXT = { active: "有效", trialing: "试用", past_due: "逾期" };
const BASIS_TEXT = { "billing-period": "本计费周期" };

export function mountDashboard(ctx, cleanups) {
  const dom = ctx.dom;
  const box = tag(dom, "div", "g-dash");
  const empty = hint(dom, "还没有数据：先在上方填写 API Key，或打开演示数据。");

  const acct = card(dom, "账户");
  const acctRow = tag(dom, "div", "g-acct");
  const acctName = tag(dom, "b");
  const acctMeta = text(dom, "", "g-muted");
  acctRow.append(acctName, acctMeta);
  const planLine = text(dom, "", "g-muted");
  acct.append(acctRow, planLine);

  const quota = tag(dom, "div", "g-card g-quota");
  const quotaTitle = tag(dom, "div", "g-card-t");
  quotaTitle.textContent = "额度";
  const rings = tag(dom, "div", "g-rings");
  const five = createRing(dom, { size: 84, label: "5 小时", kind: "five_hour" });
  const weekly = createRing(dom, { size: 84, label: "本周", kind: "weekly" });
  const monthly = createRing(dom, { size: 84, label: "本月", kind: "monthly" });
  rings.append(five.box, weekly.box, monthly.box);
  quota.append(quotaTitle, rings);

  const kpis = tag(dom, "div", "g-kpis");
  const kpiValues = {};
  for (const [key, label] of KPI_DEFS) {
    const cell = tag(dom, "div", "g-kpi");
    const value = tag(dom, "b");
    value.textContent = "—";
    cell.append(value, text(dom, label));
    kpis.append(cell);
    kpiValues[key] = value;
  }

  const alerts = tag(dom, "div", "g-alerts");
  const refreshBtn = button(dom, "立即刷新", "g-btn primary");
  refreshBtn.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "refresh" }));
  const last = text(dom, "上次刷新：—", "g-muted");
  const next = text(dom, "下次：—", "g-muted");
  const net = text(dom, "近 1 分钟出网 0 次", "g-muted");
  const actions = row(dom, refreshBtn, last, next, net);
  box.append(empty, acct, quota, kpis, alerts, actions);

  let lastView = {};

  function updateRings(view) {
    const now = Date.now();
    five.update(view.windows?.five_hour, now);
    weekly.update(view.windows?.weekly, now);
    monthly.update(view.windows?.monthly, now);
  }

  function render(view) {
    lastView = view ?? {};
    const d = lastView;
    const has = !!d.account;
    empty.className = has ? "g-muted g-hidden" : "g-muted";
    acct.className = `g-card${has ? "" : " g-hidden"}`;
    quota.className = `g-card g-quota${has ? "" : " g-hidden"}`;
    kpis.className = `g-kpis${has ? "" : " g-hidden"}`;
    alerts.className = `g-alerts${has ? "" : " g-hidden"}`;
    actions.className = `g-row${has ? "" : " g-hidden"}`;
    if (!has) return;

    acctName.textContent = d.account.name || "Command Code";
    acctMeta.textContent =
      d.account.mode === "demo" ? "演示模式" : (d.account.maskedKey ?? "未配置");
    const plan = d.plan ?? {};
    const status = STATUS_TEXT[plan.status] ?? plan.status ?? "未知";
    const parts = [plan.name, status, plan.plan_id];
    if (plan.current_period_end) parts.push(`账期至 ${fmtDateTime(plan.current_period_end)}`);
    if (plan.cancel_at_period_end) parts.push("到期取消");
    planLine.textContent = parts.filter(Boolean).join(" · ");
    planLine.className = plan.cancel_at_period_end ? "g-note" : "g-muted";

    updateRings(d);
    const credits = d.credits ?? {};
    const usage = d.usage ?? {};
    const money = { currency: d.config?.currency, usdToCny: d.config?.usdToCny };
    kpiValues.monthly.textContent = fmtCredits(credits.monthly_remaining);
    kpiValues.purchased.textContent = fmtCredits(credits.purchased);
    kpiValues.free.textContent = fmtCredits(credits.free);
    kpiValues.requests.textContent = String(usage.total_count ?? 0);
    kpiValues.cost.textContent = fmtMoney(usage.total_cost, money);
    kpiValues.avg.textContent = fmtMoney(usage.average_cost, money);
    kpiValues.success.textContent = fmtPct(usage.success_rate);
    kpiValues.tokens.textContent = `${fmtTokens(usage.tokens_in)} / ${fmtTokens(usage.tokens_out)}`;

    const list = [...(d.alerts ?? [])];
    if (d.state === "auth_error") list.unshift({ level: "danger", message: "API Key 无效或已过期。" });
    if (!list.length) list.push({ level: "info", message: "暂无告警。" });
    alerts.replaceChildren(
      ...list.map((alert) => text(dom, alert.message, `g-alert ${alert.level ?? "info"}`)),
    );

    last.textContent = `上次刷新：${d.fetchedAt ? fmtDateTime(d.fetchedAt) : "—"}`;
    next.textContent = `下次：${d.nextAt ? fmtDateTime(d.nextAt) : "—"}`;
    const netParts = [`近 1 分钟出网 ${d.net?.lastMinute ?? 0} 次`];
    if (d.net?.cooldownReason) netParts.push(d.net.cooldownReason);
    if (d.net?.lastError) netParts.push(d.net.lastError);
    if (usage.period_basis) netParts.push(BASIS_TEXT[usage.period_basis] ?? usage.period_basis);
    net.textContent = netParts.join(" · ");
    net.className = d.net?.lastError ? "g-error" : "g-muted";
  }

  const timer = setInterval(() => {
    if (lastView?.windows) updateRings(lastView);
  }, 1000);
  cleanups.push(() => clearInterval(timer));

  return { box, render };
}
