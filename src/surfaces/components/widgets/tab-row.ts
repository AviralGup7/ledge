// E4 · Tab row — the unit for open tabs (guardian), mission member tabs, recently
// closed, and search hits. Title/domain render from DTO data verbatim; chips and
// actions come from the catalog. Letter tile: first letter of the domain, a calm
// placeholder until the favicon tier lands (documented remaining work).
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';

export interface TabRowModel {
  readonly id: string;
  readonly title: string;
  readonly domain: string;
  readonly url?: string | undefined;
  readonly state?: string | undefined;
  readonly active?: boolean | undefined;
  readonly pinned?: boolean | undefined;
}

const ROW_STATE_KEYS: Readonly<Record<string, string>> = {
  live: 'msg.state.live',
  open: 'msg.state.open',
  kept: 'msg.state.kept',
  trash: 'msg.state.trash',
};

export const renderTabRow = (
  doc: Document,
  model: TabRowModel,
  actions?: readonly HTMLElement[],
): HTMLElement => {
  const row = el(doc, 'li', {
    cls: 'tab-row',
    attrs: {
      'data-tab-id': model.id,
      ...(model.state !== undefined ? { 'data-state': model.state } : {}),
    },
  });
  const initial = model.domain.length > 0 ? model.domain.charAt(0).toUpperCase() : '';
  row.appendChild(
    el(doc, 'span', { cls: 'tab-tile', text: initial, attrs: { 'aria-hidden': 'true' } }),
  );
  const body = el(doc, 'div', { cls: 'tab-body' });
  body.appendChild(
    el(doc, 'span', {
      cls: 'tab-title',
      text: model.title.length > 0 ? model.title : model.domain,
    }),
  );
  if (model.domain.length > 0)
    body.appendChild(el(doc, 'span', { cls: 'tab-domain', text: model.domain }));
  row.appendChild(body);
  if (model.state !== undefined && ROW_STATE_KEYS[model.state] !== undefined) {
    row.appendChild(
      el(doc, 'span', {
        cls: `chip chip-state chip-${model.state}`,
        text: copyOf(ROW_STATE_KEYS[model.state] ?? 'msg.state.kept'),
      }),
    );
  }
  if (model.pinned === true)
    row.appendChild(
      el(doc, 'span', {
        cls: 'chip chip-pinned',
        text: copyOf('msg.action.pin'),
        attrs: { 'aria-hidden': 'true' },
      }),
    );
  if (actions !== undefined && actions.length > 0) {
    const row2 = el(doc, 'div', { cls: 'row-actions', attrs: { role: 'toolbar' } });
    for (const a of actions) row2.appendChild(a);
    row.appendChild(row2);
  }
  return row;
};
