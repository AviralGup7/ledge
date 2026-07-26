// E4 · Minimal DOM construction — presentation plumbing only. innerHTML is never
// used anywhere in the surface layer (text goes through textContent: no HTML
// injection surface, calm by construction). Every helper takes the Document as an
// argument: surfaces run with an injected document (A-02 — no ambient globals in
// src/surfaces; roots/tests provide real/fake implementations).
export type DomEventKind = 'click' | 'input' | 'change' | 'keydown' | 'submit' | 'focusin';

export interface ElSpec {
  readonly cls?: string | undefined;
  readonly text?: string | undefined;
  readonly attrs?: Readonly<Record<string, string>> | undefined;
  readonly on?: Partial<Record<DomEventKind, (ev: Event) => void>> | undefined;
  readonly children?: readonly Node[] | undefined;
}

export const el = (doc: Document, tag: string, spec?: ElSpec): HTMLElement => {
  const node = doc.createElement(tag);
  if (spec?.cls !== undefined) node.setAttribute('class', spec.cls);
  if (spec?.text !== undefined) node.textContent = spec.text;
  if (spec?.attrs !== undefined) {
    for (const [name, value] of Object.entries(spec.attrs)) node.setAttribute(name, value);
  }
  if (spec?.on !== undefined) {
    for (const [kind, handler] of Object.entries(spec.on)) {
      if (handler !== undefined) node.addEventListener(kind, handler);
    }
  }
  if (spec?.children !== undefined) {
    for (const child of spec.children) node.appendChild(child);
  }
  return node;
};

export const clearChildren = (node: Element): void => {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
};

export const setText = (node: Element, text: string): void => {
  node.textContent = text;
};

export const setAttr = (node: Element, name: string, value: string): void => {
  node.setAttribute(name, value);
};

export const removeAttr = (node: Element, name: string): void => {
  node.removeAttribute(name);
};

/** Tag test-safe identity for interactive elements (tests assert behavior, not prose). */
export const tagOf = (node: Element): string => node.tagName.toLowerCase();

// Duck-typed value access (no `instanceof HTMLInputElement`): the unit lane runs in Node
// where DOM constructors do not exist — a string `value` slot is the whole contract.
export const inputValue = (node: Element): string => {
  const value = (node as { value?: unknown }).value;
  return typeof value === 'string' ? value : '';
};

export const setInputValue = (node: Element, value: string): void => {
  const target = node as { value?: unknown };
  if (typeof target.value === 'string') target.value = value;
};
