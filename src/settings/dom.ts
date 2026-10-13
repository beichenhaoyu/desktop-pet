export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
