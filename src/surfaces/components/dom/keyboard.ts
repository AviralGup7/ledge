// E4 · Keyboard layer — declarative combo binding for every surface (EES §7.4: full
// keyboard operability of every workflow). Combos are technical strings ('enter',
// 'ctrl+shift+k'), never user copy; hint text comes from the catalog at render sites.
export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
}

export const KEYS = {
  enter: 'enter',
  escape: 'escape',
  arrowDown: 'arrowdown',
  arrowUp: 'arrowup',
  tab: 'tab',
  home: 'home',
  end: 'end',
} as const;

interface Combo {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

const parseCombo = (combo: string): Combo => {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  return {
    key,
    ctrl: parts.includes('ctrl'),
    meta: parts.includes('meta'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
};

export const matchesCombo = (ev: KeyboardEventLike, combo: string): boolean => {
  const c = parseCombo(combo);
  return (
    ev.key.toLowerCase() === c.key &&
    ev.ctrlKey === c.ctrl &&
    ev.metaKey === c.meta &&
    ev.shiftKey === c.shift &&
    ev.altKey === c.alt
  );
};

// Duck-typed tag inspection (no `instanceof Element`): the unit lane runs in Node where
// DOM constructors do not exist — a string tagName is the whole contract needed here.
const isEditableTarget = (ev: Event): boolean => {
  const target = ev.target as { tagName?: unknown } | null;
  if (target === null || typeof target !== 'object' || typeof target.tagName !== 'string') {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

export interface KeyBinding {
  readonly combo: string;
  readonly run: (ev: KeyboardEventLike) => void;
  /** When false (default) the binding is inert while a text field has focus —
   *  typing prose never fires surface commands. */
  readonly allowInInput?: boolean | undefined;
}

export interface KeyTarget {
  addEventListener(kind: string, handler: (ev: Event) => void): void;
  removeEventListener(kind: string, handler: (ev: Event) => void): void;
}

/**
 * Bind a shortcut set on a root element/document; returns the detach handle
 * (cleanup law: surfaces unbind exactly what they bound on unmount).
 */
export const bindKeys = (target: KeyTarget, bindings: readonly KeyBinding[]): (() => void) => {
  const handler = (ev: Event): void => {
    if (!('key' in ev) || typeof (ev as { key?: unknown }).key !== 'string') return;
    const keyEvent = ev as unknown as KeyboardEventLike;
    for (const binding of bindings) {
      if (!matchesCombo(keyEvent, binding.combo)) continue;
      if (binding.allowInInput !== true && isEditableTarget(ev)) continue;
      keyEvent.preventDefault();
      binding.run(keyEvent);
      return;
    }
  };
  target.addEventListener('keydown', handler);
  return () => {
    target.removeEventListener('keydown', handler);
  };
};
