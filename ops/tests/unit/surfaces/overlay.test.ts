// E4 · Overlay surface suite — Reflex Search. Laws: debounced SearchQuery riding
// the registry payload; results are SearchResultsView hits rendered verbatim; the
// fallback freshness note is honest copy; kept hits activate through ResumeMission
// (close only on Applied); live hits are an honest no-op note (no v1 wire verb);
// trash hits are inert; escape/close semantics; unmount releases everything.
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import { mountOverlay, type Mounted } from '@/surfaces/overlay/overlay.js';
import type { OverlayDeps, SwitcherItemModel } from '@/surfaces/overlay/overlay.js';
import {
  FakeDocument,
  asDocument,
  fireInput,
  fireKey,
  mustQuery,
  type FakeElement,
} from './fake-dom.js';
import {
  createFakeTransport,
  createTestEntropy,
  flush,
  type FakeTransport,
} from './fake-transport.js';

interface OverlayHarness {
  readonly doc: FakeDocument;
  readonly fake: FakeTransport;
  readonly mounted: Mounted;
  readonly fireDebounce: () => void;
  readonly closes: () => number;
  readonly unmount: () => void;
}

const mount = (options?: { readonly switcher?: OverlayDeps['switcher'] }): OverlayHarness => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  let pendingDebounce: (() => void) | undefined;
  let closeCount = 0;
  const mounted = mountOverlay(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
    debounce: (_delayMs, fn) => {
      pendingDebounce = fn;
      return () => {
        if (pendingDebounce === fn) pendingDebounce = undefined;
      };
    },
    close: () => {
      closeCount += 1;
    },
    ...(options?.switcher !== undefined ? { switcher: options.switcher } : {}),
  });
  return {
    doc,
    fake,
    mounted,
    fireDebounce: () => pendingDebounce?.(),
    closes: () => closeCount,
    unmount: () => mounted.unmount(),
  };
};

const RESULTS = {
  results: [
    {
      tabId: '01HF7YCQVR90000R0000000000',
      missionId: '01HF7YAT001000000000000000',
      title: 'Kept paper',
      url: 'https://papers.example.com/a',
      domain: 'papers.example.com',
      state: 'kept',
    },
    {
      tabId: '01HF7YCZK7P000000000000000',
      missionId: '01HF7YB1QFE000000000000000',
      title: 'Open draft',
      url: 'https://drafts.example.com/b',
      domain: 'drafts.example.com',
      state: 'live',
    },
    {
      tabId: '01HF7YD7AP30000S0000000R00',
      missionId: '01HF7YAT001000000000000000',
      title: 'Old thread',
      url: 'https://threads.example.com/c',
      domain: 'threads.example.com',
      state: 'trash',
    },
  ],
  freshness: 'fresh',
  searchedScopes: ['all'],
};

const input = (doc: FakeDocument): FakeElement => mustQuery(doc.body, 'input[role="combobox"]');

/** Type + debounce-fire + answer the query, the complete round trip. */
const search = async (
  doc: FakeDocument,
  fake: FakeTransport,
  fire: () => void,
  q: string,
  answer: unknown,
): Promise<void> => {
  fireInput(input(doc), q);
  fire();
  await flush();
  const env = fake.lastOf('SearchQuery');
  fake.apply(env.cid, answer);
  await flush();
};

describe('E4 overlay · search round trip', () => {
  it('typing debounces into exactly one SearchQuery with the registry payload', async () => {
    const { doc, fake, fireDebounce, unmount } = mount();
    fireInput(input(doc), 'p');
    fireInput(input(doc), 'pa');
    fireInput(input(doc), 'pap');
    expect(fake.countOf('SearchQuery')).toBe(0); // debounce held
    fireDebounce(); // only the latest debounce is live (earlier ones were cancelled)
    await flush();
    expect(fake.countOf('SearchQuery')).toBe(1);
    const env = fake.lastOf('SearchQuery');
    expect(env.kind).toBe('query');
    expect(env.payload).toEqual({ q: 'pap', scope: 'all', limit: 20 });
    expect(env.senderContext).toBe('overlay');
    fake.apply(env.cid, RESULTS);
    await flush();
    unmount();
  });

  it('empty queries never hit the wire', async () => {
    const { doc, fake, fireDebounce, unmount } = mount();
    fireInput(input(doc), 'a');
    fireDebounce();
    await flush();
    fake.apply(fake.lastOf('SearchQuery').cid, RESULTS);
    fireInput(input(doc), '   ');
    fireDebounce();
    fireInput(input(doc), '');
    fireDebounce();
    await flush();
    expect(fake.countOf('SearchQuery')).toBe(1);
    unmount();
  });

  it('results render as options grouped by state with title + domain', async () => {
    const { doc, fake, fireDebounce, unmount } = mount();
    await search(doc, fake, fireDebounce, 'thread', RESULTS);
    const options = doc.body.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain('Kept paper');
    expect(options[0]?.textContent).toContain('papers.example.com');
    expect(options.filter((o) => o.getAttribute('data-group') === 'kept')).toHaveLength(1);
    unmount();
  });

  it('fallback freshness renders the honest "keyword results" note', async () => {
    const { doc, fake, fireDebounce, unmount } = mount();
    await search(doc, fake, fireDebounce, 'x', { ...RESULTS, freshness: 'fallback' });
    expect(doc.body.textContent).toContain(copyOf('msg.note.fallback'));
    unmount();
  });

  it('misses render the empty-search note', async () => {
    const { doc, fake, fireDebounce, unmount } = mount();
    await search(doc, fake, fireDebounce, 'zzz', {
      results: [],
      freshness: 'fresh',
      searchedScopes: ['all'],
    });
    expect(doc.body.textContent).toContain(copyOf('msg.empty.search'));
    unmount();
  });

  it('a failed search shows the error block (never silent, never stale results)', async () => {
    const { doc, fake, fireDebounce, unmount } = mount();
    fireInput(input(doc), 'boom');
    fireDebounce();
    await flush();
    fake.fail(fake.lastOf('SearchQuery').cid, {
      code: 'E_PROVIDER',
      messageKey: 'msg.error.provider',
    });
    await flush();
    expect(doc.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(doc.body.textContent).toContain(copyOf('msg.error.provider'));
    expect(doc.body.querySelectorAll('[role="option"]')).toHaveLength(0);
    unmount();
  });
});

describe('E4 overlay · activation (the one reflex)', () => {
  it('kept hit: enter sends ResumeMission; the overlay closes only on Applied (R1)', async () => {
    const { doc, fake, fireDebounce, closes, unmount } = mount();
    await search(doc, fake, fireDebounce, 'kept', RESULTS);
    fireKey(input(doc), { key: 'Enter' }); // first item is the kept hit
    await flush();
    const sent = fake.lastOf('ResumeMission');
    expect(sent.kind).toBe('command');
    expect(sent.payload).toEqual({ missionId: '01HF7YAT001000000000000000', mode: 'full' });
    expect(closes()).toBe(0); // acknowledged is not applied — still open
    fake.apply(sent.cid, {
      missionId: '01HF7YAT001000000000000000',
      restoredTabIds: ['01HF7YCQVR90000R0000000000'],
    });
    await flush();
    expect(closes()).toBe(1);
    unmount();
  });

  it('kept-hit activation failure shows the error and does NOT close', async () => {
    const { doc, fake, fireDebounce, closes, unmount } = mount();
    await search(doc, fake, fireDebounce, 'kept', RESULTS);
    fireKey(input(doc), { key: 'Enter' });
    await flush();
    fake.fail(fake.lastOf('ResumeMission').cid, {
      code: 'E_CAPABILITY',
      messageKey: 'msg.error.capability',
    });
    await flush();
    expect(closes()).toBe(0);
    expect(doc.body.querySelector('[role="alert"]')).not.toBeNull();
    unmount();
  });

  it('live hit: honest "already open" note, no command leaves the surface', async () => {
    const { doc, fake, fireDebounce, closes, unmount } = mount();
    await search(doc, fake, fireDebounce, 'live', RESULTS);
    const commandsBefore = fake.sent.filter((e) => e.kind === 'command').length;
    mustQuery(doc.body, '[data-group="live"]').click();
    await flush();
    expect(fake.sent.filter((e) => e.kind === 'command')).toHaveLength(commandsBefore);
    expect(doc.body.textContent).toContain(copyOf('msg.note.already-open'));
    expect(closes()).toBe(0);
    unmount();
  });

  it('trash hits are inert from search (recovery lives in the quiet page)', async () => {
    const { doc, fake, fireDebounce, closes, unmount } = mount();
    await search(doc, fake, fireDebounce, 'old', RESULTS);
    const commandsBefore = fake.sent.filter((e) => e.kind === 'command').length;
    mustQuery(doc.body, '[data-group="trash"]').click();
    await flush();
    expect(fake.sent.filter((e) => e.kind === 'command')).toHaveLength(commandsBefore);
    expect(doc.body.textContent).not.toContain(copyOf('msg.note.already-open'));
    expect(closes()).toBe(0);
    unmount();
  });

  it('arrow-down + enter activates the chosen hit (keyboard-first contract)', async () => {
    const { doc, fake, fireDebounce, closes, unmount } = mount();
    await search(doc, fake, fireDebounce, 'draft', RESULTS);
    fireKey(input(doc), { key: 'ArrowDown' }); // selection → item 0
    fireKey(input(doc), { key: 'ArrowDown' }); // selection → item 1 (live)
    fireKey(input(doc), { key: 'Enter' });
    await flush();
    expect(doc.body.textContent).toContain(copyOf('msg.note.already-open'));
    expect(closes()).toBe(0);
    unmount();
  });
});

describe('E4 overlay · close & lifecycle', () => {
  it('escape closes the overlay without touching the wire', () => {
    const { doc, fake, closes, unmount } = mount();
    fireKey(input(doc), { key: 'Escape' });
    expect(closes()).toBe(1);
    expect(fake.sent).toHaveLength(0);
    unmount();
  });

  it('the input is focused on mount (type-immediately reflex)', () => {
    const { doc, unmount } = mount();
    expect(input(doc).focused).toBe(true);
    unmount();
  });

  it('ResyncRequired schema shows the honest error block', async () => {
    const { doc, fake, unmount } = mount();
    fake.emitStream('ResyncRequired', { reason: 'schema' });
    await flush();
    const alert = mustQuery(doc.body, '[role="alert"]');
    expect(alert.textContent).toContain(copyOf('msg.error.output'));
    expect(alert.textContent).toContain(copyOf('msg.recover.report'));
    unmount();
  });

  it('unmount detaches streams, cancels a held debounce and removes the root', async () => {
    const { doc, fake, fireDebounce, mounted } = mount();
    fireInput(input(doc), 'held');
    await flush();
    expect(fake.listenerCount()).toBe(1);
    mounted.unmount();
    fireDebounce(); // cancelled at unmount — nothing fires
    await flush();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.countOf('SearchQuery')).toBe(0);
    expect(doc.body.querySelector('[data-surface="overlay"]')).toBeNull();
    expect(doc.body.querySelector('[data-live-region]')).toBeNull();
  });
});

describe('E8-T09 overlay · command door + switcher (Spec W8 · C28 · §9 two-doors)', () => {
  const MISSIONS: readonly SwitcherItemModel[] = [
    { missionId: 'm-open', name: 'Research sprint', cls: 'open', tabCount: 5, windowId: 7 },
    { missionId: 'm-parked', name: 'Visa paperwork', cls: 'parked', tabCount: 3, windowId: null },
  ];

  const mountSwitcher = (
    script?: OverlayDeps['switcher'],
  ): { h: OverlayHarness; calls: [string, boolean][] } => {
    const calls: [string, boolean][] = [];
    const seam: OverlayDeps['switcher'] = script ?? {
      list: () => Promise.resolve(MISSIONS),
      switch: (id, parkCurrent) => {
        calls.push([id, parkCurrent]);
        return Promise.resolve();
      },
    };
    return { h: mount({ switcher: seam }), calls };
  };

  const verbItem = (doc: FakeDocument): FakeElement =>
    mustQuery(doc.body, '[data-item-id="verb.switch-mission"]');

  it('D1: the ">" prefix shows the switch verb verbatim — and WITHOUT the seam, ">" is ordinary search text', async () => {
    const { h } = mountSwitcher();
    fireInput(input(h.doc), '>');
    await flush();
    expect(verbItem(h.doc).textContent).toContain('Switch to a mission');
    expect(h.fake.countOf('SearchQuery')).toBe(0); // door mode never hits the things wire
    h.unmount();
    // Absence-by-default: no seam ⇒ the door is shut; '>' behaves as plain text.
    const plain = mount();
    fireInput(input(plain.doc), '>x');
    plain.fireDebounce();
    await flush();
    expect(plain.fake.lastOf('SearchQuery').payload).toEqual({ q: '>x', scope: 'all', limit: 20 });
    expect(plain.doc.body.querySelector('[data-item-id="verb.switch-mission"]')).toBeNull();
    plain.unmount();
  });

  it('D2: activating the verb enters W8 — open-first order, honest subs, the Alt modifier hint', async () => {
    const { h } = mountSwitcher();
    fireInput(input(h.doc), '>');
    await flush();
    verbItem(h.doc).click();
    await flush();
    expect(input(h.doc).value).toBe(''); // mode entry clears the door text
    const openItem = mustQuery(h.doc.body, '[data-item-id="mission.m-open"]');
    const parkedItem = mustQuery(h.doc.body, '[data-item-id="mission.m-parked"]');
    const rows = h.doc.body
      .querySelectorAll('.palette-item')
      .map((n) => n.getAttribute('data-item-id'));
    expect(rows.indexOf('mission.m-open')).toBeLessThan(rows.indexOf('mission.m-parked')); // W8 order verbatim
    expect(openItem.getAttribute('data-group')).toBe('open');
    expect(parkedItem.getAttribute('data-group')).toBe('parked');
    expect(mustQuery(h.doc.body, '[data-palette-note]').textContent).toContain(
      'Alt+Enter parks the current window first',
    );
    // Client-side filter within the door:
    fireInput(input(h.doc), 'visa');
    await flush();
    expect(h.doc.body.querySelector('[data-item-id="mission.m-open"]')).toBeNull();
    expect(mustQuery(h.doc.body, '[data-item-id="mission.m-parked"]').textContent).toContain(
      'Visa paperwork',
    );
    h.unmount();
  });

  it('D3 · CRITERION: activation without Alt switches only; WITH Alt it is park-current-then-switch (W8 modifier)', async () => {
    const { h, calls } = mountSwitcher();
    fireInput(input(h.doc), '>');
    await flush();
    verbItem(h.doc).click();
    await flush();
    fireKey(input(h.doc), { key: 'enter' }); // first row = open-first head (no modifier)
    await flush();
    expect(calls).toEqual([['m-open', false]]);
    expect(h.closes()).toBe(1); // a plain switch closes the overlay
    h.unmount();
    const second = mountSwitcher();
    fireInput(input(second.h.doc), '>');
    await flush();
    verbItem(second.h.doc).click();
    await flush();
    fireKey(input(second.h.doc), { key: 'enter', altKey: true }); // W8's "park current, then switch"
    await flush();
    expect(second.calls).toEqual([['m-open', true]]);
    second.h.unmount();
  });

  it('D4: a torn switch shows clear language and the overlay stays open (W8 failure law)', async () => {
    const { h } = mountSwitcher({
      list: () => Promise.resolve(MISSIONS),
      switch: () => Promise.reject(new Error('park failed: tabs lost')),
    });
    fireInput(input(h.doc), '>');
    await flush();
    verbItem(h.doc).click();
    await flush();
    fireKey(input(h.doc), { key: 'enter' });
    await flush();
    expect(h.closes()).toBe(0); // never half-executed, never silently dismissed
    const alert = mustQuery(h.doc.body, '[role="alert"]'); // clear language block, honest copy
    expect(alert.textContent).toContain(copyOf('msg.error.output'));
    h.unmount();
  });

  it('D5: Escape steps OUT of the switcher before closing (two doors, two depths)', async () => {
    const { h } = mountSwitcher();
    fireInput(input(h.doc), '>');
    await flush();
    verbItem(h.doc).click();
    await flush();
    expect(mustQuery(h.doc.body, '[data-item-id="mission.m-open"]')).not.toBeNull();
    fireKey(input(h.doc), { key: 'escape' }); // depth 1: leave the switcher, keep the overlay
    await flush();
    expect(h.closes()).toBe(0);
    expect(h.doc.body.querySelector('[data-item-id="mission.m-open"]')).toBeNull();
    expect(input(h.doc).value).toBe('');
    fireKey(input(h.doc), { key: 'escape' }); // depth 2: now close
    await flush();
    expect(h.closes()).toBe(1);
    h.unmount();
  });
});
