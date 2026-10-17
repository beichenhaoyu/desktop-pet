// badge：宠物旁的小字。没有内容时整块不挂（ADR-0010 决策 1），
// 不能画空框，也不要用 display:none —— 宿主按插槽外壳尺寸判断有没有内容。
import { fmtCountdown, fmtMoney, fmtPct } from "../format.js";
import { toneOfPct } from "../charts.js";
import { TOPIC_CMD, TOPIC_WIDGET } from "../topics.js";
import { addStyle, tag, text } from "./dom.js";

const CSS = `
  .g-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
    border-radius: 999px; font: 12px/1.35 "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #eaf1f8; background: rgba(10,14,20,.72); border: 1px solid rgba(255,255,255,.12);
    white-space: nowrap; }
  .g-badge .g-dot { width: 7px; height: 7px; border-radius: 50%; background: #9aa4b2; }
  .g-badge.good .g-dot { background: #4ade80; }
  .g-badge.warn .g-dot { background: #f5c518; }
  .g-badge.bad .g-dot { background: #ff6b6b; }
`;

const MODES = {
  five_hour: { window: "five_hour", prefix: "5h" },
  weekly: { window: "weekly", prefix: "周" },
  monthly: { window: "monthly", prefix: "月" },
};

export function mountBadge(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(dom, root, CSS);

  const badge = tag(dom, "div", "g-badge");
  const dot = tag(dom, "i", "g-dot");
  const label = text(dom, "5h", "g-badge-text");
  badge.append(dot, label);

  let lastView = null;
  let mounted = false;

  function render(view) {
    lastView = view ?? null;
    const d = lastView;
    if (!d || d.state === "onboarding" || !d.account || !d.windows) {
      if (mounted) badge.remove();
      mounted = false;
      return;
    }

    if (d.state === "auth_error") {
      label.textContent = "Key 失效";
      badge.className = "g-badge bad";
      if (!mounted) {
        root.append(badge);
        mounted = true;
      }
      return;
    }

    const mode = d.config?.badgeMode === "cost_today" ? "cost_today" : d.config?.badgeMode;
    if (mode === "cost_today") {
      const cost = Number(d.usage?.total_cost);
      if (!Number.isFinite(cost)) {
        if (mounted) badge.remove();
        mounted = false;
        return;
      }
      badge.className = "g-badge";
      label.textContent = `本期 ${fmtMoney(cost, d.config ?? {})}`;
    } else {
      const meta = MODES[mode] ?? MODES.five_hour;
      const window = d.windows?.[meta.window];
      if (!window) {
        if (mounted) badge.remove();
        mounted = false;
        return;
      }
      const now = Date.now();
      const pct = Number(window.remaining_pct);
      const resetAt = Number(window.reset_at) || 0;
      const countdown = resetAt > now ? ` · ${fmtCountdown(resetAt, now)}` : "";
      if (window.exceeded === true) {
        label.textContent = `${meta.prefix} 已用尽${countdown}`;
        badge.className = "g-badge bad";
      } else if (!Number.isFinite(pct)) {
        label.textContent = `${meta.prefix} —`;
        badge.className = "g-badge";
      } else {
        label.textContent = `${meta.prefix} ${fmtPct(pct)}${countdown}`;
        badge.className = `g-badge ${toneOfPct(pct)}`;
      }
    }

    if (!mounted) {
      root.append(badge);
      mounted = true;
    }
  }

  const timer = setInterval(() => {
    if (lastView) render(lastView);
  }, 1000);
  cleanups.push(() => clearInterval(timer));
  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (view) => render(view ?? {})));
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
}
