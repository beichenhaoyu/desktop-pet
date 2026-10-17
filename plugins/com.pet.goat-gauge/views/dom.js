// Widget 三区共用的小件。所有节点都从 ctx.dom 建；没有 innerHTML / 文本节点。
const SVG_NS = "http://www.w3.org/2000/svg";

export function addStyle(dom, root, css) {
  const node = dom.createElement("style");
  node.textContent = css;
  root.append(node);
  return node;
}

export function tag(dom, name, cls) {
  const node = dom.createElement(name);
  if (cls) node.className = cls;
  return node;
}

export function text(dom, content, cls) {
  const node = tag(dom, "span", cls);
  node.textContent = String(content ?? "");
  return node;
}

export function button(dom, label, cls) {
  const node = tag(dom, "button", cls);
  node.type = "button";
  node.textContent = label;
  return node;
}

export function input(dom, type, cls) {
  const node = tag(dom, "input", cls);
  node.type = type;
  return node;
}

/** SVG 节点只收契约白名单里的标签与属性。 */
export function svg(dom, name, attrs = {}) {
  const node = dom.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  return node;
}

export function row(dom, ...nodes) {
  const box = tag(dom, "div", "g-row");
  box.append(...nodes);
  return box;
}

export function hint(dom, content) {
  return text(dom, content, "g-muted");
}

export function card(dom, title, ...nodes) {
  const box = tag(dom, "div", "g-card");
  if (title) {
    const head = tag(dom, "div", "g-card-t");
    head.textContent = title;
    box.append(head);
  }
  box.append(...nodes);
  return box;
}
