// E5-T01 · QueryService.search integration laws (the application half): optional rank
// port composed ⇒ ranked head ∪ bounded sweep tail under 'fresh'|'lagging'; port
// absent/unavailable ⇒ §6.6 sweep under 'fallback'; rows the store can't produce are
// dropped (never fabricated); limit clamp, dedupe, closed-scope union ride as before.
import { describe, expect, it } from 'vitest';
import type { SearchRankPort } from '@/application/ports/search.port.js';
import { ok } from '@/shared-kernel/result/index.js';
import {
  ledgeTabIdOf,
  liveTabPlan,
  makeServices,
  mustOk,
  testId,
  type SeedPlan,
} from './services.testkit.js';

const missionIdOf = (n: number): string => testId(40_000 + n);

const missionPlan = (m: number, name: string, tabNums: readonly number[]): SeedPlan => ({
  type: 'MissionFormed',
  payload: {
    missionId: missionIdOf(m),
    name,
    namedBy: 'user',
    tabIds: tabNums.map(ledgeTabIdOf),
  },
});

const assignedPlan = (n: number, m: number): SeedPlan => ({
  type: 'TabAssigned',
  payload: { tabId: ledgeTabIdOf(n), missionId: missionIdOf(m) },
});

const port = (over: Partial<SearchRankPort>): SearchRankPort => ({
  query: async () => ok({ kind: 'unavailable' as const, reason: 'absent' as const }),
  dupesFor: async () => ok([]),
  freshness: async () => ok({ lag: 0, dirty: false, tokenizerV: 1 }),
  ensureIndexFresh: async () => undefined,
  ...over,
});

const rankedPort = (
  hits: readonly {
    readonly tabId: string;
    readonly score: number;
    readonly state: 'live' | 'kept';
  }[],
  freshness: 'fresh' | 'lagging',
): SearchRankPort =>
  port({
    query: async () => ok({ kind: 'ok' as const, answer: { hits, freshness } }),
  });

describe('E5 queries.search · fallback law stays intact without a working port', () => {
  it('no search dep ⇒ pure sweep, freshness fallback (E3 behavior preserved)', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1, { title: 'purple pricing' })]);
    const res = await mustOk(h.services.queries.search({ q: 'purple' }));
    expect(res.freshness).toBe('fallback');
    expect(res.results.length).toBe(1);
  });

  it('port answers unavailable ⇒ sweep runs and says fallback', async () => {
    const h = await makeServices({ search: port({}) });
    await h.seed([liveTabPlan(1, { title: 'purple pricing' })]);
    const res = await mustOk(h.services.queries.search({ q: 'purple' }));
    expect(res.freshness).toBe('fallback');
    expect(res.results.length).toBe(1);
  });
});

describe('E5 queries.search · ranked head ∪ sweep tail', () => {
  it('fresh: ranked head orders first; substring-only recall still arrives via the tail', async () => {
    const h = await makeServices({
      search: rankedPort([{ tabId: ledgeTabIdOf(1), score: 9, state: 'kept' }], 'fresh'),
    });
    await h.seed([
      liveTabPlan(1, { title: 'exact token match' }),
      assignedPlan(1, 1),
      liveTabPlan(2, { title: 'a zqexactfib substring row' }),
    ]);
    const res = await mustOk(h.services.queries.search({ q: 'exact' }));
    expect(res.freshness).toBe('fresh');
    expect(res.results[0]?.tabId).toBe(ledgeTabIdOf(1));
    expect(res.results.map((r) => r.tabId)).toContain(ledgeTabIdOf(2));
  });

  it('lagging: merge is deduped (never a double row) and honestly flagged', async () => {
    const h = await makeServices({
      search: rankedPort([{ tabId: ledgeTabIdOf(1), score: 5, state: 'live' }], 'lagging'),
    });
    await h.seed([liveTabPlan(1, { title: 'purple table' })]);
    const res = await mustOk(h.services.queries.search({ q: 'purple' }));
    expect(res.freshness).toBe('lagging');
    expect(res.results.length).toBe(1);
  });

  it('ranked rows the store cannot produce are DROPPED, never fabricated', async () => {
    const h = await makeServices({
      search: rankedPort(
        [
          { tabId: ledgeTabIdOf(1), score: 9, state: 'kept' },
          { tabId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', score: 1, state: 'kept' },
        ],
        'fresh',
      ),
    });
    await h.seed([liveTabPlan(1, { title: 'unique flossword' }), assignedPlan(1, 1)]);
    const res = await mustOk(h.services.queries.search({ q: 'flossword' }));
    expect(res.results.map((r) => r.tabId)).toEqual([ledgeTabIdOf(1)]);
    expect(res.results[0]?.state).toBe('kept');
    expect(res.results[0]?.missionId).toBe(missionIdOf(1));
  });

  it('live ranked hits surface state open with the full DTO shape', async () => {
    const h = await makeServices({
      search: rankedPort([{ tabId: ledgeTabIdOf(1), score: 7, state: 'live' }], 'fresh'),
    });
    await h.seed([liveTabPlan(1, { title: 'unique zorptitle', url: 'https://zorp.test/page' })]);
    const res = await mustOk(h.services.queries.search({ q: 'zorptitle' }));
    expect(res.results[0]?.state).toBe('open');
    expect(res.results[0]?.url).toBe('https://zorp.test/page');
  });

  it('closed scope unions the recently-closed sweep content (no closed corpus in the index)', async () => {
    const h = await makeServices({ search: rankedPort([], 'fresh') });
    await h.seed([
      liveTabPlan(1, { title: 'closed floss topic' }),
      missionPlan(1, 'bin', [1]),
      assignedPlan(1, 1),
      { type: 'TabClosedExternal', payload: { ledgeTabId: ledgeTabIdOf(1), closedAt: 2 } },
    ]);
    const res = await mustOk(h.services.queries.search({ q: 'floss', scope: 'closed' }));
    expect(res.freshness).toBe('fresh');
    expect(res.results.map((r) => r.tabId)).toContain(ledgeTabIdOf(1));
  });

  it('limit clamp caps merged output at the bound', async () => {
    const h = await makeServices({
      search: rankedPort([{ tabId: ledgeTabIdOf(1), score: 9, state: 'live' }], 'fresh'),
    });
    await h.seed([
      liveTabPlan(1, { title: 'clampmatch one' }),
      liveTabPlan(2, { title: 'clampmatch two' }),
      liveTabPlan(3, { title: 'clampmatch three' }),
    ]);
    const res = await mustOk(h.services.queries.search({ q: 'clampmatch', limit: 2 }));
    expect(res.results.length).toBe(2);
    expect(res.results[0]?.tabId).toBe(ledgeTabIdOf(1));
  });

  it('empty q short-circuits before the port (no index touch)', async () => {
    let calls = 0;
    const h = await makeServices({
      search: port({
        query: async () => {
          calls += 1;
          return ok({ kind: 'unavailable' as const, reason: 'absent' as const });
        },
      }),
    });
    const res = await mustOk(h.services.queries.search({ q: '   ' }));
    expect(res.results.length).toBe(0);
    expect(calls).toBe(0);
  });
});
