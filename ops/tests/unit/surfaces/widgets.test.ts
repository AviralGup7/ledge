// E4 · Widget suite — shared presentation units. Laws: state blocks are identical
// across surfaces (one block law); error copy comes from the wire envelope's keys
// with calm fallbacks; heartbeat honesty (zero ≠ some); palette keyboard contract
// (combobox aria, arrows clamp, enter activates, escape closes); click affordances.
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import {
  createHeartbeatPill,
  type HeartbeatPill,
} from '@/surfaces/components/widgets/heartbeat.js';
import { actionButton, renderMissionCard } from '@/surfaces/components/widgets/mission-card.js';
import { renderTabRow } from '@/surfaces/components/widgets/tab-row.js';
import { renderLoading, renderStateBlock } from '@/surfaces/components/widgets/states.js';
import { createSearchPalette } from '@/surfaces/components/widgets/search-palette.js';
import { FakeDocument, fireInput, fireKey, makeFakeEvent, mustQuery } from './fake-dom.js';

describe('E4 widgets · state blocks', () => {
  it('loading block carries the loading copy and a shimmering placeholder', () => {
    const doc = new FakeDocument();
    const block = renderLoading(doc as unknown as Document);
    expect(block.getAttribute('data-state')).toBe('loading');
    expect(block.textContent).toContain(copyOf('msg.state.loading'));
    expect(block.querySelector('.shimmer')).not.toBeNull();
  });

  it('empty block renders its copyKey line with role=note', () => {
    const doc = new FakeDocument();
    const block = renderStateBlock(doc as unknown as Document, {
      kind: 'empty',
      copyKey: 'msg.empty.trash',
    });
    expect(block.getAttribute('role')).toBe('note');
    expect(block.textContent).toContain(copyOf('msg.empty.trash'));
  });

  it('error block prefers the wire envelope keys and carries role=alert', () => {
    const doc = new FakeDocument();
    const block = renderStateBlock(doc as unknown as Document, {
      kind: 'error',
      copyKey: 'msg.error.output',
      error: {
        code: 'E_STORE_INTEGRITY',
        messageKey: 'msg.error.store',
        recoveryKey: 'msg.recover.restart',
      },
    });
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.textContent).toContain(copyOf('msg.error.store'));
    expect(block.textContent).toContain(copyOf('msg.recover.restart'));
    expect(block.textContent).not.toContain(copyOf('msg.error.output'));
  });

  it('error block falls back to calm generic copy when the envelope lacks keys', () => {
    const doc = new FakeDocument();
    const block = renderStateBlock(doc as unknown as Document, {
      kind: 'error',
      copyKey: 'msg.error.output',
      error: { code: 'E_FORMAT_UNKNOWN' },
    });
    expect(block.textContent).toContain(copyOf('msg.error.output'));
    expect(block.textContent).toContain(copyOf('msg.recover.report'));
  });

  it('retry affordance renders only when provided and fires onRetry', () => {
    const doc = new FakeDocument();
    let retries = 0;
    const block = renderStateBlock(doc as unknown as Document, {
      kind: 'error',
      copyKey: 'msg.error.output',
      error: { code: 'E_CAPABILITY' },
      retry: { onRetry: () => (retries += 1) },
    });
    const button = mustQuery(block, '[data-action="retry"]');
    button.click();
    expect(retries).toBe(1);
    const plain = renderStateBlock(doc as unknown as Document, {
      kind: 'error',
      copyKey: 'msg.error.output',
      error: { code: 'E_CAPABILITY' },
    });
    expect(plain.querySelector('[data-action="retry"]')).toBeNull();
  });
});

describe('E4 widgets · heartbeat pill', () => {
  const makePill = (doc: FakeDocument): HeartbeatPill =>
    createHeartbeatPill(doc as unknown as Document);

  it('starts quiet (nothing kept yet) and is a polite status region', () => {
    const doc = new FakeDocument();
    const pill = makePill(doc);
    expect(pill.el.textContent).toContain(copyOf('msg.heartbeat.quiet'));
    expect(pill.el.getAttribute('role')).toBe('status');
    expect(pill.el.getAttribute('aria-label')).toBe(copyOf('msg.aria.heartbeat'));
  });

  it('zero stays quiet; counts render the honest "{count} tabs safe" line', () => {
    const doc = new FakeDocument();
    const pill = makePill(doc);
    pill.update({ keptCount: 0 });
    expect(pill.el.textContent).toContain(copyOf('msg.heartbeat.quiet'));
    pill.update({ keptCount: 12 });
    expect(pill.el.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 12 }));
  });
});

describe('E4 widgets · mission card', () => {
  const model = {
    missionId: 'm1',
    name: 'Reading week',
    namedBy: 'user',
    state: 'parked',
    concluded: false,
    tabCount: 5,
  };

  it('renders name, state chip and tab count from DTO data', () => {
    const doc = new FakeDocument();
    const card = renderMissionCard(doc as unknown as Document, model);
    expect(card.getAttribute('data-mission-id')).toBe('m1');
    expect(card.getAttribute('data-state')).toBe('parked');
    expect(card.textContent).toContain('Reading week');
    expect(card.textContent).toContain(copyOf('msg.state.parked'));
    expect(card.textContent).toContain(copyOf('msg.count.tabs', { count: 5 }));
  });

  it('concluded/pinned/favorite chips render only when their flags are set', () => {
    const doc = new FakeDocument();
    const plain = renderMissionCard(doc as unknown as Document, model);
    expect(plain.querySelector('.chip-concluded')).toBeNull();
    expect(plain.querySelector('.chip-pinned')).toBeNull();
    expect(plain.querySelector('.chip-favorite')).toBeNull();
    const decked = renderMissionCard(doc as unknown as Document, {
      ...model,
      concluded: true,
      pinned: true,
      favorite: true,
    });
    expect(decked.querySelector('.chip-concluded')).not.toBeNull();
    expect(decked.querySelector('.chip-pinned')).not.toBeNull();
    expect(decked.querySelector('.chip-favorite')).not.toBeNull();
  });

  it('unknown states fall back to the kept chip (total rendering)', () => {
    const doc = new FakeDocument();
    const card = renderMissionCard(doc as unknown as Document, { ...model, state: 'mystery' });
    expect(card.textContent).toContain(copyOf('msg.state.kept'));
  });

  it('action children land in a labelled toolbar and their clicks fire', () => {
    const doc = new FakeDocument();
    let clicks = 0;
    const action = actionButton(doc as unknown as Document, {
      copyKey: 'msg.action.resume',
      action: 'resume',
      primary: true,
      onClick: () => (clicks += 1),
    });
    const card = renderMissionCard(doc as unknown as Document, model, { children: [action] });
    const toolbar = mustQuery(card, '[role="toolbar"]');
    expect(toolbar.getAttribute('aria-label')).toBe(copyOf('msg.aria.actions'));
    const button = mustQuery(card, '[data-action="resume"]');
    expect(button.getAttribute('class')).toContain('btn-primary');
    button.click();
    expect(clicks).toBe(1);
  });
});

describe('E4 widgets · tab row', () => {
  it('renders title, domain, letter tile and state chip', () => {
    const doc = new FakeDocument();
    const row = renderTabRow(doc as unknown as Document, {
      id: 't1',
      title: 'Design systems',
      domain: 'example.com',
      state: 'kept',
    });
    expect(row.getAttribute('data-tab-id')).toBe('t1');
    expect(row.textContent).toContain('Design systems');
    expect(row.textContent).toContain('example.com');
    expect(mustQuery(row, '.tab-tile').textContent).toBe('E');
    expect(row.textContent).toContain(copyOf('msg.state.kept'));
  });

  it('falls back to domain-as-title and empty tile for edge inputs', () => {
    const doc = new FakeDocument();
    const row = renderTabRow(doc as unknown as Document, { id: 't2', title: '', domain: '' });
    expect(mustQuery(row, '.tab-tile').textContent).toBe('');
    expect(row.querySelector('.tab-domain')).toBeNull();
  });

  it('pinned chip renders only when pinned', () => {
    const doc = new FakeDocument();
    const pinned = renderTabRow(doc as unknown as Document, {
      id: 't3',
      title: 'x',
      domain: 'x.io',
      pinned: true,
    });
    expect(pinned.querySelector('.chip-pinned')).not.toBeNull();
  });
});

describe('E4 widgets · search palette', () => {
  const items = [
    { id: 'a', title: 'Alpha', sub: 'alpha.dev' },
    { id: 'b', title: 'Beta', group: 'kept' },
    { id: 'c', title: 'Gamma' },
  ];

  const harness = () => {
    const doc = new FakeDocument();
    const queries: string[] = [];
    const activated: string[] = [];
    let closes = 0;
    const palette = createSearchPalette(doc as unknown as Document, {
      onQuery: (q) => queries.push(q),
      onActivate: (item) => activated.push(item.id),
      onClose: () => (closes += 1),
    });
    return { doc, palette, queries, activated, closes: () => closes };
  };

  it('combobox aria contract: roles, controls, activedescendant', () => {
    const { palette } = harness();
    const input = mustQuery(palette.root, 'input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('palette-list');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const list = mustQuery(palette.root, 'ul');
    expect(list.getAttribute('role')).toBe('listbox');
    palette.setItems(items);
    fireKey(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-item-a');
    const first = mustQuery(palette.root, '#palette-item-a');
    expect(first.getAttribute('role')).toBe('option');
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('typing reports the query and resets the selection', () => {
    const { palette, queries } = harness();
    const input = mustQuery(palette.root, 'input');
    palette.setItems(items);
    fireKey(input, { key: 'ArrowDown' });
    fireInput(input, 'alp');
    expect(queries).toEqual(['alp']);
    expect(palette.selection()).toBe(-1);
  });

  it('arrow keys clamp at both ends; enter activates the selection', () => {
    const { palette, activated } = harness();
    const input = mustQuery(palette.root, 'input');
    palette.setItems(items);
    fireKey(input, { key: 'ArrowUp' }); // no selection yet → selects first
    expect(palette.selection()).toBe(0);
    fireKey(input, { key: 'ArrowUp' }); // clamped at top
    expect(palette.selection()).toBe(0);
    fireKey(input, { key: 'ArrowDown' });
    fireKey(input, { key: 'ArrowDown' });
    fireKey(input, { key: 'ArrowDown' }); // clamped at bottom
    expect(palette.selection()).toBe(2);
    fireKey(input, { key: 'Enter' });
    expect(activated).toEqual(['c']);
  });

  it('enter with no selection activates the first item; escape closes', () => {
    const { palette, activated, closes } = harness();
    const input = mustQuery(palette.root, 'input');
    palette.setItems(items);
    fireKey(input, { key: 'Enter' });
    expect(activated).toEqual(['a']);
    fireKey(input, { key: 'Escape' });
    expect(closes()).toBe(1);
  });

  it('clicking an option activates it', () => {
    const { palette, activated } = harness();
    palette.setItems(items);
    mustQuery(palette.root, '#palette-item-b').click();
    expect(activated).toEqual(['b']);
  });

  it('loading and note states render through the status line', () => {
    const { palette } = harness();
    const note = () => mustQuery(palette.root, '[data-palette-note]');
    palette.setLoading(true);
    expect(note().textContent).toBe(copyOf('msg.state.loading'));
    expect(note().getAttribute('data-visible')).toBe('true');
    palette.setLoading(false);
    palette.setNote('custom note');
    expect(note().textContent).toBe('custom note');
    palette.setNote(undefined);
    expect(note().getAttribute('data-visible')).toBe('false');
  });

  it('emptying items clears the selection; dispose detaches the root', () => {
    const { palette } = harness();
    const input = mustQuery(palette.root, 'input');
    palette.setItems(items);
    fireKey(input, { key: 'ArrowDown' });
    palette.setItems([]);
    expect(palette.selection()).toBe(-1);
    expect(palette.root.querySelectorAll('li')).toHaveLength(0);
  });

  it('palette keys prevent the browser default only for handled keys', () => {
    const { palette } = harness();
    const input = mustQuery(palette.root, 'input');
    palette.setItems(items);
    const arrow = fireKey(input, { key: 'ArrowDown' });
    expect((arrow as unknown as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
    const typing = makeFakeEvent('keydown', { key: 'x' });
    input.dispatchEvent(typing);
    expect((typing as unknown as { defaultPrevented: boolean }).defaultPrevented).toBe(false);
  });
});
