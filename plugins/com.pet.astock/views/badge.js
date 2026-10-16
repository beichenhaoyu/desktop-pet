import { addStyle, fmtPct, tag, text, toneOf } from "./dom.js";
import { watchView } from "./watch.js";

/* ================= badge：宠物旁小字 ================= */

export function mountBadge(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(
    dom,
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
  const box = tag(dom, "div", "astock-badge");
  const nm = text(dom, "盯盘", "nm");
  const pc = text(dom, "", "flat");
  box.append(nm, pc);
  // 空态（无自选或无行情）不把框挂进树：外壳尺寸非零是宿主判断「有内容」的唯一信号
  //（ADR-0010 落地口径第 1 条），样式表本身是零尺寸、常驻不影响量法

  cleanups.push(
    watchView(ctx, (d) => {
      const list = d.watch ?? [];
      const first = list.length ? d.quotes?.[list[0].secid] : null;
      const idx = d.config?.showIndex ? d.quotes?.[d.config.indexSecid] : null;
      const q = first ?? idx;
      if (!q) {
        box.remove();
        return;
      }
      nm.textContent = q.name ?? "盯盘";
      pc.textContent = fmtPct(q.pct);
      pc.className = toneOf(q);
      root.append(box);
    }),
  );
}
