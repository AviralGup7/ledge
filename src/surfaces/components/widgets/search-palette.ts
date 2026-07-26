// E4 · Search palette — the reflex-search widget (Spec §6.6: a reflex layer over
// every surface). Keyboard-first: type → ArrowDown/Up → Enter activates, Escape
// closes. Owns NO query logic: the surface feeds it items and receives the chosen
// id. Copy arrives via catalog keys at the render sites.
import { copyOf } from '../copy/copy.js';
import { clearChildren, el } from '../dom/dom.js';
import { KEYS } from '../dom/keyboard.js';

export interface PaletteItem {
  readonly id: string;
  readonly title: string;
  readonly sub?: string | undefined;
  readonly group?: string | undefined;
}

export interface PaletteCallbacks {
  readonly onQuery: (q: string) => void;
  readonly onActivate: (item: PaletteItem) => void;
  readonly onClose: () => void;
}

export interface SearchPalette {
  readonly root: HTMLElement;
  readonly focus: () => void;
  readonly query: () => string;
  readonly setItems: (items: readonly PaletteItem[]) => void;
  readonly setLoading: (loading: boolean) => void;
  readonly setNote: (text: string | undefined) => void;
  readonly selection: () => number;
  readonly dispose: () => void;
}

const NO_SELECTION = -1;

export const createSearchPalette = (doc: Document, cb: PaletteCallbacks): SearchPalette => {
  let items: readonly PaletteItem[] = [];
  let selected = NO_SELECTION;
  let loading = false;
  let note: string | undefined;

  const input = el(doc, 'input', {
    cls: 'palette-input',
    attrs: {
      type: 'search',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'palette-list',
      'aria-label': copyOf('msg.aria.palette'),
      placeholder: copyOf('msg.hint.search'),
      autocomplete: 'off',
      spellcheck: 'false',
    },
  }) as HTMLInputElement;

  const list = el(doc, 'ul', {
    cls: 'palette-list',
    attrs: { id: 'palette-list', role: 'listbox', 'aria-label': copyOf('msg.aria.results') },
  });
  const statusLine = el(doc, 'p', { cls: 'palette-note', attrs: { 'data-palette-note': '' } });

  const activeDescendant = (): string => {
    const item = items[selected];
    return item === undefined ? '' : `palette-item-${item.id}`;
  };

  const render = (): void => {
    clearChildren(list);
    items.forEach((item, index) => {
      const option = el(doc, 'li', {
        cls: index === selected ? 'palette-item is-selected' : 'palette-item',
        attrs: {
          id: `palette-item-${item.id}`,
          role: 'option',
          'data-item-id': item.id,
          'aria-selected': index === selected ? 'true' : 'false',
          ...(item.group !== undefined ? { 'data-group': item.group } : {}),
        },
        on: {
          click: () => cb.onActivate(item),
        },
      });
      option.appendChild(el(doc, 'span', { cls: 'palette-item-title', text: item.title }));
      if (item.sub !== undefined)
        option.appendChild(el(doc, 'span', { cls: 'palette-item-sub', text: item.sub }));
      list.appendChild(option);
    });
    input.setAttribute('aria-activedescendant', activeDescendant());
    statusLine.textContent = loading ? copyOf('msg.state.loading') : (note ?? '');
    statusLine.setAttribute('data-visible', loading || note !== undefined ? 'true' : 'false');
  };

  const moveSelection = (delta: number): void => {
    if (items.length === 0) return;
    const next = selected === NO_SELECTION ? 0 : selected + delta;
    const clamped = Math.max(0, Math.min(items.length - 1, next));
    if (clamped !== selected) {
      selected = clamped;
      render();
    }
  };

  input.addEventListener('input', () => {
    selected = NO_SELECTION;
    cb.onQuery(input.value);
  });
  input.addEventListener('keydown', (ev: Event) => {
    if (!('key' in ev) || typeof (ev as { key?: unknown }).key !== 'string') return;
    const key = (ev as { key: string }).key.toLowerCase();
    if (key === KEYS.arrowDown) {
      ev.preventDefault();
      moveSelection(1);
    } else if (key === KEYS.arrowUp) {
      ev.preventDefault();
      moveSelection(-1);
    } else if (key === KEYS.enter) {
      ev.preventDefault();
      const item = items[selected === NO_SELECTION ? 0 : selected];
      if (item !== undefined) cb.onActivate(item);
    } else if (key === KEYS.escape) {
      ev.preventDefault();
      cb.onClose();
    }
  });

  const root = el(doc, 'div', {
    cls: 'palette',
    attrs: { role: 'dialog', 'aria-label': copyOf('msg.aria.palette'), 'data-widget': 'palette' },
    children: [input, list, statusLine],
  });
  render();

  return {
    root,
    focus: () => input.focus(),
    query: () => input.value,
    setItems: (next) => {
      items = next;
      if (items.length === 0) selected = NO_SELECTION;
      render();
    },
    setLoading: (v) => {
      loading = v;
      render();
    },
    setNote: (text) => {
      note = text;
      render();
    },
    selection: () => selected,
    dispose: () => {
      root.remove();
    },
  };
};
