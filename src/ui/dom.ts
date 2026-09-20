/** 极简 DOM 构建助手 —— 类型安全的 createElement 包装。 */

type Child = Node | string | null | undefined | false;
type AttrValue = string | number | boolean | undefined | null | (() => void);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === "function") {
      node.addEventListener(k.replace(/^on/, "").toLowerCase(), v as EventListener);
    } else if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

/** 清空并重建一个容器的子节点。 */
export function replaceChildren(node: HTMLElement, ...children: Child[]): void {
  node.replaceChildren();
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
}
