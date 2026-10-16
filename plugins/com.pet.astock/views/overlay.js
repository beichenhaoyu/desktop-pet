import { addStyle, clockOf, fmtPct, fmtPrice, PHASE_TEXT, tag, text, toneOf } from "./dom.js";
import { watchView } from "./watch.js";

/* ================= overlay：桌面盯盘卡（位置由插件自己给） ================= */

export function mountOverlay(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(
    dom,
    root,
    `
    .card {
      font: 12px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
      background: rgba(17,19,24,.86); color: #e6e8ee; border-radius: 12px;
      padding: 8px 10px; max-width: 300px; box-shadow: 0 6px 22px rgba(0,0,0,.34);
    }
    .hd { display: flex; justify-content: space-between; font-size: 11px; color: #9aa3b2; margin-bottom: 4px; gap: 10px; }
    .row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: baseline; padding: 1px 0; }
    .row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
    .row .pr, .row .pc { font-variant-numeric: tabular-nums; }
    .row .pc { min-width: 58px; text-align: right; }
    .up { color: #ff6b6b; } .down { color: #4ade80; } .flat { color: #cbd2dc; }
    .idx { border-top: 1px solid rgba(255,255,255,.12); margin-top: 4px; padding-top: 4px; }
    .empty { color: #9aa3b2; }
    `,
  );
  const card = tag(dom, "div", "card");
  const phase = text(dom, "");
  const updated = text(dom, "");
  const head = tag(dom, "div", "hd");
  head.append(phase, updated);
  const body = tag(dom, "div");
  card.append(head, body);
  root.append(card);

  const rowOf = (q, name, cls) => {
    const row = tag(dom, "div", `row ${cls ?? ""}`);
    // 百分比那个 span 存住引用再改类名：契约里没有 lastChild（旧代码用的是它）
    const pc = text(dom, fmtPct(q?.pct), toneOf(q));
    pc.className = `pc ${toneOf(q)}`;
    row.append(text(dom, q?.name ?? name, "nm"), text(dom, fmtPrice(q?.price), "pr"), pc);
    return row;
  };

  cleanups.push(
    watchView(ctx, (d) => {
      phase.textContent = PHASE_TEXT[d.session?.phase] ?? "";
      updated.textContent = clockOf(d.updatedAt);
      body.replaceChildren();
      const list = d.watch ?? [];
      if (!list.length) {
        body.append(text(dom, "还没有自选股，去插件页添加", "empty"));
        return;
      }
      for (const item of list) body.append(rowOf(d.quotes?.[item.secid], item.name));
      const idxQ = d.config?.showIndex ? d.quotes?.[d.config.indexSecid] : null;
      if (idxQ) body.append(rowOf(idxQ, idxQ.name, "idx"));
    }),
  );
}
