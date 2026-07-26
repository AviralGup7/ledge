// E3-T03 · ADR-032 contract suite — NativeSessionsPort laws, adapter-parametric.
//   N1 tab-shaped backlog entries surface as {url,title} candidates in chrome order
//   N2 window-shaped entries fan out per member tab (session order, then member order)
//   N3 url-less rows are dropped at the adapter boundary (unmatchable ≠ evidence)
//   N4 empty backlog ⇒ ok([])
//   N5 the platform ceiling: 30 tab-shaped entries ⇒ exactly the capped backlog
//   N6 capability-class rejection ⇒ E_CAPABILITY_API
//   N7 read-only law: the port surface carries exactly one method (no restore path)
import { describe, expect, it } from 'vitest';
import type { NativeSessionsPort } from '@/application/ports/sessions.port.js';
import type { ChromeSessionLike } from '@/infrastructure/chrome/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

export interface SessionsPortBinding {
  readonly makeAdapter: () => NativeSessionsPort;
  readonly seedRecentlyClosed: (sessions: readonly ChromeSessionLike[]) => void;
  readonly sabotageNext: ((cause: unknown) => void) | null;
}

const CAP = 25;
const OVER_CAP = 30;

const tabSession = (n: number): ChromeSessionLike => ({
  lastModified: 1_700_000_000_000 + n,
  tab: {
    id: n,
    windowId: 1,
    url: `https://closed-${n}.example/page`,
    title: `closed ${n}`,
    sessionId: `s-${n}`,
  },
});

export function describeSessionsPortContract(name: string, binding: SessionsPortBinding): void {
  describe(`NativeSessionsPort contract [${name}]`, () => {
    it('N1: tab-shaped entries surface as candidates in chrome backlog order', async () => {
      binding.seedRecentlyClosed([tabSession(1), tabSession(2)]);
      const rows = unwrap(await binding.makeAdapter().recentlyClosedTabs());
      expect(rows.map((r) => r.url)).toEqual([
        'https://closed-1.example/page',
        'https://closed-2.example/page',
      ]);
      expect(rows[0]?.title).toBe('closed 1');
    });

    it('N2: window-shaped entries fan out per member tab', async () => {
      binding.seedRecentlyClosed([
        {
          lastModified: 1_700_000_000_100,
          window: {
            id: 7,
            sessionId: 'w-7',
            tabs: [
              { id: 11, windowId: 7, url: 'https://w7.example/a', title: 'a', sessionId: 's-11' },
              { id: 12, windowId: 7, url: 'https://w7.example/b', title: 'b', sessionId: 's-12' },
            ],
          },
        },
        tabSession(3),
      ]);
      const rows = unwrap(await binding.makeAdapter().recentlyClosedTabs());
      expect(rows.map((r) => r.url)).toEqual([
        'https://w7.example/a',
        'https://w7.example/b',
        'https://closed-3.example/page',
      ]);
    });

    it('N3: url-less rows are dropped (an unmatchable candidate is never evidence)', async () => {
      binding.seedRecentlyClosed([
        { lastModified: 1, tab: { id: 21, windowId: 1, title: 'no url here', sessionId: 's-21' } },
        tabSession(4),
      ]);
      const rows = unwrap(await binding.makeAdapter().recentlyClosedTabs());
      expect(rows.map((r) => r.url)).toEqual(['https://closed-4.example/page']);
    });

    it('N4: empty backlog resolves ok([]) — absence is data, never an error', async () => {
      binding.seedRecentlyClosed([]);
      expect(unwrap(await binding.makeAdapter().recentlyClosedTabs())).toEqual([]);
    });

    it('N5: the platform ceiling caps a 30-entry backlog at 25', async () => {
      binding.seedRecentlyClosed(Array.from({ length: OVER_CAP }, (_, i) => tabSession(i + 1)));
      const rows = unwrap(await binding.makeAdapter().recentlyClosedTabs());
      expect(rows.length).toBe(CAP);
      expect(rows.at(-1)?.url).toBe(`https://closed-${CAP}.example/page`);
    });

    it('N6: capability-class rejection maps to E_CAPABILITY_API', async () => {
      if (binding.sabotageNext === null) return;
      binding.sabotageNext(new Error('sessions backend revoked'));
      const r = await binding.makeAdapter().recentlyClosedTabs();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_CAPABILITY_API');
    });

    it('N7: read-only law — the surface carries exactly recentlyClosedTabs', () => {
      expect(Object.keys(binding.makeAdapter())).toEqual(['recentlyClosedTabs']);
    });
  });
}
