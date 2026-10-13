import { addStyle, fmtPct, tag, text, toneOf } from "./dom.js";
import { watchView } from "./watch.js";

/* ================= badge：宠物旁小字 ================= */

export function mountBadge(root, ctx, cleanups) {
  addStyle(
    root,
    `
    .astock-badge {
      font: 12px/1.35 "Segoe UI", "Microsoft YaHei", sans-serif;
      background: rgba(17,19,24,.82); color: #e6e8ee; border-radius: 999px;
      padding: 3px 9px; display: inline-flex; gap: 6px; align-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.28); white-space: nowrap;
    }
    .astock-badge .nm { max-width: 92px; overflow: hidden; text-overflow: ellipsis; }
    .up { color: #ff6b6b; } .down { color: #4ade80; } .flat { color: #cbd2dc; }
    `,
  );
  const box = tag("div", "astock-badge");
  const nm = text("盯盘", "nm");
  const pc = text("", "flat");
  box.append(nm, pc);
  root.append(box);

  cleanups.push(
    watchView(ctx, (d) => {
      const list = d.watch ?? [];
      const first = list.length ? d.quotes?.[list[0].secid] : null;
      const idx = d.config?.showIndex ? d.quotes?.[d.config.indexSecid] : null;
      const q = first ?? idx;
      box.style.display = q || list.length ? "inline-flex" : "none";
      nm.textContent = q?.name ?? (list.length ? "盯盘" : "未加自选");
      pc.textContent = q ? fmtPct(q.pct) : "";
      pc.className = toneOf(q);
    }),
  );
}
