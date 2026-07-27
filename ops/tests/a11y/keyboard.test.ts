// E7-T03 · §7.4 keyboard operability flows (zero-defect row 1: every workflow
// reachable without a pointer). Overlay palette: arrows move the
// aria-activedescendant, enter activates the selection, escape closes, bounds
// clamp. Guardian/quiet: undo combos fire from the page body; typing inside a
// field NEVER fires a surface command (the allowInInput law — prose is sacred).
import { describe, expect, it } from 'vitest';
import { mountGuardian } from '@/surfaces/guardian/guardian.js';
import { mountOverlay } from '@/surfaces/overlay/overlay.js';
import { mountQuietPage } from '@/surfaces/quiet-page/quiet.js';
import {
  FakeDocument,
  asDocument,
  fireKey,
  fireInput,
  mustQuery,
} from '../unit/surfaces/fake-dom.js';
import {
  createFakeTransport,
  createTestEntropy,
  flush,
  type FakeTransport,
} from '../unit/surfaces/fake-transport.js';

const BOOTSTRAP = {
  missions: [
    {
      missionId: 'm1',
      name: 'One',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabCount: 1,
    },
  ],
  recentlyClosed: [],
  trashCount: 0,
  watermark: 1,
  settings: {},
  heartbeat: { keptCount: 2, liveRecoverable: 0, asOf: 0 },
};

const OPEN_TAB = {
  browserTabId: 31,
  windowId: 1,
  title: 'A tab',
  url: 'https://a.example.com/',
  pinned: false,
  active: false,
  groupId: null,
};

const SEARCH_RESULTS = {
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
  ],
  freshness: 'fresh',
  searchedScopes: ['all'],
};

const answerQueries = async (
  fake: FakeTransport,
  values: Record<string, unknown>,
): Promise<void> => {
  const ROUNDS = 2;
  for (let round = 0; round < ROUNDS; round += 1) {
    await flush();
    for (const env of [...fake.sent]) {
      if (env.kind === 'query' && env.name in values) fake.apply(env.cid, values[env.name]);
    }
    await flush();
  }
};

const mountGuardianWithAnswers = async () => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  const mounted = mountGuardian(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
  });
  await answerQueries(fake, { GetBootstrap: BOOTSTRAP, PeekOpenTabs: [OPEN_TAB] });
  return { doc, fake, mounted };
};

const mountQuietWithAnswers = async () => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  const mounted = mountQuietPage(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
  });
  await answerQueries(fake, {
    GetBootstrap: BOOTSTRAP,
    GetLibrary: { missions: BOOTSTRAP.missions },
  });
  return { doc, fake, mounted };
};

const mountOverlayShell = () => {
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
  });
  return {
    doc,
    fake,
    mounted,
    fireDebounce: () => pendingDebounce?.(),
    closes: () => closeCount,
  };
};

describe('E7-T03 a11y · overlay palette keyboard contract', () => {
  const typeAndAnswer = async (h: ReturnType<typeof mountOverlayShell>): Promise<void> => {
    fireInput(mustQuery(h.doc.body, 'input[role="combobox"]'), 'pap');
    h.fireDebounce();
    await flush();
    const query = h.fake.lastOf('SearchQuery');
    h.fake.apply(query.cid, SEARCH_RESULTS);
    await flush();
  };

  it('arrows drive aria-activedescendant over options; bounds clamp', async () => {
    const h = mountOverlayShell();
    await typeAndAnswer(h);
    const input = mustQuery(h.doc.body, 'input[role="combobox"]');
    expect(h.doc.body.querySelectorAll('[role="option"]')).toHaveLength(2);
    // The palette re-renders on every move — re-query the (fresh) nodes per step.
    const freshOptions = (): readonly { el: ReturnType<typeof mustQuery>; selected: boolean }[] =>
      h.doc.body.querySelectorAll('[role="option"]').map((el) => ({
        el,
        selected: el.getAttribute('aria-selected') === 'true',
      }));
    const descendantOf = (index: number): string | null =>
      freshOptions()[index]?.el.getAttribute('id') ?? null;
    expect(input.getAttribute('aria-activedescendant')).toBe('');

    fireKey(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(descendantOf(0));
    expect(freshOptions()[0]?.selected).toBe(true);

    fireKey(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(descendantOf(1));

    // Clamp at the end: further ArrowDowns never escape the listbox.
    fireKey(input, { key: 'ArrowDown' });
    fireKey(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(descendantOf(1));

    fireKey(input, { key: 'ArrowUp' });
    fireKey(input, { key: 'ArrowUp' });
    fireKey(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(descendantOf(0));
    h.mounted.unmount();
  });

  it('enter activates the arrowed selection (kept hit → ResumeMission)', async () => {
    const h = mountOverlayShell();
    await typeAndAnswer(h);
    const input = mustQuery(h.doc.body, 'input[role="combobox"]');
    fireKey(input, { key: 'ArrowDown' });
    fireKey(input, { key: 'Enter' });
    await flush();
    const sent = h.fake.lastOf('ResumeMission');
    expect(sent.kind).toBe('command');
    expect(sent.payload).toEqual({ missionId: '01HF7YAT001000000000000000', mode: 'full' });
    h.mounted.unmount();
  });

  it('escape closes the palette', async () => {
    const h = mountOverlayShell();
    await typeAndAnswer(h);
    fireKey(mustQuery(h.doc.body, 'input[role="combobox"]'), { key: 'Escape' });
    await flush();
    expect(h.closes()).toBe(1);
    h.mounted.unmount();
  });
});

describe('E7-T03 a11y · surface undo/refresh combos', () => {
  it('guardian: u fires Undo; r refreshes; typing u inside a field fires nothing', async () => {
    const { doc, fake, mounted } = await mountGuardianWithAnswers();
    const undosBefore = fake.sent.filter((env) => env.name === 'Undo').length;
    fireKey(doc.body, { key: 'u' });
    await flush();
    expect(fake.sent.filter((env) => env.name === 'Undo')).toHaveLength(undosBefore + 1);

    const bootstrapsBefore = fake.sent.filter((env) => env.name === 'GetBootstrap').length;
    fireKey(doc.body, { key: 'r' });
    await flush();
    expect(fake.sent.filter((env) => env.name === 'GetBootstrap').length).toBeGreaterThan(
      bootstrapsBefore,
    );

    // The allowInInput law: prose fields never trigger surface commands.
    const field = doc.body.querySelector('input');
    if (field !== null) {
      const undosNow = fake.sent.filter((env) => env.name === 'Undo').length;
      fireKey(field, { key: 'u' });
      await flush();
      expect(fake.sent.filter((env) => env.name === 'Undo')).toHaveLength(undosNow);
    }
    mounted.unmount();
  });

  it('quiet: u and ctrl+z fire Undo; a settings field swallows the combo', async () => {
    const { doc, fake, mounted } = await mountQuietWithAnswers();
    fireKey(doc.body, { key: 'u' });
    await flush();
    fireKey(doc.body, { key: 'z', ctrlKey: true });
    await flush();
    expect(fake.sent.filter((env) => env.name === 'Undo')).toHaveLength(2);

    doc.body.querySelector('[data-nav="settings"]')?.click();
    await flush();
    const field = doc.body.querySelector('input');
    if (field !== null) {
      fireKey(field, { key: 'u' });
      await flush();
      expect(fake.sent.filter((env) => env.name === 'Undo')).toHaveLength(2);
    }
    mounted.unmount();
  });
});
