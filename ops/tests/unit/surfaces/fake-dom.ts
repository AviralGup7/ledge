// E4 testkit · Fake DOM — a Node-native implementation of the exact DOM vocabulary
// the surface layer uses (createElement, attributes, textContent, tree navigation,
// attribute/tag/class selectors, target-scoped event listeners, input values).
// No jsdom: the unit lane deliberately runs with zero DOM globals, so the fakes
// double as proof that surfaces touch nothing beyond this injected Document seam
// (roots give them the real document in production; tests give them this).
export type FakeNode = FakeElement | FakeText;

interface FakeListener {
  readonly kind: string;
  readonly handler: (ev: Event) => void;
}

const CLASS_SEPARATOR = /\s+/;
const SELECTOR_SPLIT = /\s+/;
const COMPOUND_PART = /(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[\w-]+(?:="[^"]*")?\])/g;
const ATTR_PART = /^\[([\w-]+)(?:="([^"]*)")?\]$/;

const textOf = (node: FakeNode): string =>
  node instanceof FakeText ? node.data : node.children.map(textOf).join('');

export class FakeText {
  public parent: FakeElement | null = null;

  public constructor(public data: string) {}
}

export class FakeElement {
  public readonly tagName: string;
  public readonly children: FakeNode[] = [];
  public parent: FakeElement | null = null;
  public value = '';
  public checked = false;
  public focused = false;
  private readonly attributes = new Map<string, string>();
  private readonly listeners: FakeListener[] = [];

  public constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  // ── attributes ─────────────────────────────────────────────────────────────
  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public get classList(): readonly string[] {
    const cls = this.attributes.get('class');
    if (cls === undefined) return [];
    return cls.split(CLASS_SEPARATOR).filter((c) => c.length > 0);
  }

  // ── tree ───────────────────────────────────────────────────────────────────
  public appendChild<T extends FakeNode>(child: T): T {
    if (child instanceof FakeElement && child.parent !== null) child.parent.removeChild(child);
    if (child instanceof FakeText && child.parent !== null) child.parent.removeChild(child);
    this.children.push(child);
    child.parent = this;
    return child;
  }

  public removeChild<T extends FakeNode>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
    }
    return child;
  }

  public remove(): void {
    this.parent?.removeChild(this);
  }

  public get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  public get lastElementChild(): FakeElement | null {
    for (let i = this.children.length - 1; i >= 0; i -= 1) {
      const node = this.children[i];
      if (node instanceof FakeElement) return node;
    }
    return null;
  }

  public get elementChildren(): readonly FakeElement[] {
    return this.children.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  public get textContent(): string {
    return textOf(this);
  }

  public set textContent(text: string) {
    for (const child of this.children) {
      if (child instanceof FakeElement) child.parent = null;
    }
    this.children.length = 0;
    if (text.length > 0) this.appendChild(new FakeText(text));
  }

  // ── events (target-scoped; matches the surfaces' usage exactly) ─────────────
  public addEventListener(kind: string, handler: (ev: Event) => void): void {
    this.listeners.push({ kind, handler });
  }

  public removeEventListener(kind: string, handler: (ev: Event) => void): void {
    const index = this.listeners.findIndex((l) => l.kind === kind && l.handler === handler);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  public listenerCount(kind: string): number {
    return this.listeners.filter((l) => l.kind === kind).length;
  }

  /** Synchronous dispatch: the surface listeners run in registration order. */
  public dispatchEvent(ev: Event): void {
    Object.defineProperty(ev, 'target', { value: this, configurable: true });
    for (const listener of [...this.listeners]) {
      if (listener.kind === ev.type) listener.handler(ev);
    }
  }

  public click(): void {
    this.dispatchEvent(makeFakeEvent('click'));
  }

  public focus(): void {
    this.focused = true;
  }

  // ── selectors ('#id', 'tag', '.class', '[attr]', '[attr="v"]', descendant) ──
  public querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): readonly FakeElement[] {
    const compounds = selector
      .trim()
      .split(SELECTOR_SPLIT)
      .filter((s) => s.length > 0);
    if (compounds.length === 0) return [];
    const out: FakeElement[] = [];
    const visit = (node: FakeElement, applySelf: boolean): void => {
      if (applySelf && matchesChain(node, compounds, this)) out.push(node);
      for (const child of node.children) {
        if (child instanceof FakeElement) visit(child, true);
      }
    };
    visit(this, false);
    return out;
  }
}

/** Compound matching with descendant combinator walked via parents (scope-checked). */
const matchesChain = (
  el: FakeElement,
  compounds: readonly string[],
  scope: FakeElement,
): boolean => {
  const last = compounds[compounds.length - 1];
  if (last === undefined || !matchesCompound(el, last)) return false;
  if (compounds.length === 1) return true;
  let ancestor = el.parent;
  let index = compounds.length - 2;
  while (ancestor !== null) {
    const part = compounds[index];
    if (part !== undefined && matchesCompound(ancestor, part)) {
      index -= 1;
      if (index < 0) return true;
    }
    if (ancestor === scope) break;
    ancestor = ancestor.parent;
  }
  return false;
};

const matchesCompound = (el: FakeElement, compound: string): boolean => {
  const parts = compound.match(COMPOUND_PART);
  if (parts === null || parts.join('') !== compound) return false;
  for (const part of parts) {
    if (part.startsWith('#')) {
      if (el.getAttribute('id') !== part.slice(1)) return false;
    } else if (part.startsWith('.')) {
      if (!el.classList.includes(part.slice(1))) return false;
    } else if (part.startsWith('[')) {
      const attr = ATTR_PART.exec(part);
      if (attr === null) return false;
      const name = attr[1] ?? '';
      const expected = attr[2];
      if (!el.hasAttribute(name)) return false;
      if (expected !== undefined && el.getAttribute(name) !== expected) return false;
    } else if (el.tagName !== part.toUpperCase()) {
      return false;
    }
  }
  return true;
};

export interface FakeKeyboardInit {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

/** A duck-typed Event; the target is stamped at dispatch-time like the real DOM. */
export const makeFakeEvent = (type: string, init?: FakeKeyboardInit): Event => {
  let defaultPrevented = false;
  const ev = {
    type,
    key: init?.key,
    ctrlKey: init?.ctrlKey ?? false,
    metaKey: init?.metaKey ?? false,
    shiftKey: init?.shiftKey ?? false,
    altKey: init?.altKey ?? false,
    target: null,
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault() {
      defaultPrevented = true;
    },
  };
  return ev as unknown as Event;
};

/** Fire a keydown through the real listener path (target = el). */
export const fireKey = (el: FakeElement, init: FakeKeyboardInit): Event => {
  const ev = makeFakeEvent('keydown', init);
  el.dispatchEvent(ev);
  return ev;
};

/** Fire 'input' with the control's current value set first (the DOM sequence). */
export const fireInput = (el: FakeElement, value: string): void => {
  el.value = value;
  el.dispatchEvent(makeFakeEvent('input'));
};

export class FakeDocument {
  public readonly body: FakeElement;
  public visibilityState: 'visible' | 'hidden' = 'visible';
  private readonly listeners: FakeListener[] = [];

  public constructor() {
    this.body = new FakeElement('body');
  }

  public createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  public createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  public querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }

  public querySelectorAll(selector: string): readonly FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  public addEventListener(kind: string, handler: (ev: Event) => void): void {
    this.listeners.push({ kind, handler });
  }

  public removeEventListener(kind: string, handler: (ev: Event) => void): void {
    const index = this.listeners.findIndex((l) => l.kind === kind && l.handler === handler);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  public dispatchEvent(ev: Event): void {
    Object.defineProperty(ev, 'target', { value: this, configurable: true });
    for (const listener of [...this.listeners]) {
      if (listener.kind === ev.type) listener.handler(ev);
    }
  }

  /** Exact id lookup (HTML semantics; attribute equality, NOT CSS — ids may hold dots). */
  public getElementById(id: string): FakeElement | null {
    for (const el of this.allElements()) {
      if (el.getAttribute('id') === id) return el;
    }
    return null;
  }

  /** Test helper: every live element in document order. */
  public allElements(): readonly FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      out.push(node);
      for (const child of node.children) {
        if (child instanceof FakeElement) visit(child);
      }
    };
    visit(this.body);
    return out;
  }
}

/** Ergonomic alias: surfaces take `doc: Document`; tests cast at the call site. */
export const asDocument = (doc: FakeDocument): Document => doc as unknown as Document;

/** Query one element or fail the test loudly (assert ergonomics for suites). */
export const mustQuery = (
  scope: { querySelector: (s: string) => FakeElement | null },
  selector: string,
): FakeElement => {
  const found = scope.querySelector(selector);
  if (found === null) throw new Error(`fake-dom: no element matches ${selector}`);
  return found;
};
