// E5-T01 · SearchRankPort adapter — full-stack laws over the real journal + V1
// projection engine + memory storage: ranked hits, scope filters, freshness lag
// disclosure, availability-as-value (absent/dirty/tokenizer-mismatch), rebuild
// self-heal, dupesFor. The fallback itself is application-side (queries suite).
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import {
  DEV_A,
  makeProjections,
  seedJournal,
  tabId,
  testId,
  type ProjectionHarness,
} from '@/infrastructure/projections/testkit.js';
import { META_JOURNAL_HEADS_KEY } from '@/infrastructure/journal/index.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';
import type { SearchRankReply } from '@/application/ports/search.port.js';
import { SEARCH_STATS_KEY } from './index.projector.js';
import { TOKENIZER_V } from './tokenizer.js';
import { createSearchRankAdapter } from './search.adapter.js';

const WALL = 1_800_000_000_000;
// Per-world journal counter — the journal's contiguity law requires seqs to start
// at 1 per device stream, so world() resets this and every envelope is contiguous.
let seqCounter = 0;
const ev = (type: string, payload: Record<string, unknown>): EventEnvelope => {
  seqCounter += 1;
  const seq = seqCounter;
  return {
    eventId: testId(50_000 + seq) as EventEnvelope['eventId'],
    hlc: { seq, lamport: seq, deviceId: DEV_A as DeviceId, wallClock: WALL + seq },
    type: type as EventEnvelope['type'],
    payload: payload as EventEnvelope['payload'],
    producerContext: 'sw',
  };
};

// Full contract payload (registry: browserTabId/windowId/urlCanon/canonRulesV are
// REQUIRED — append validation rejects partial rows with E_OUTPUT_MALFORMED).
const observe = (n: number, title: string, url: string): EventEnvelope => {
  const canon = canonicalize(url);
  return ev('TabObserved', {
    ledgeTabId: tabId(n),
    browserTabId: 40_000 + n,
    windowId: 7,
    url,
    urlCanon: canon.canonForm,
    canonRulesV: canon.rulesVersion,
    title,
    domain: canon.domain,
    ts: WALL + n,
  });
};

const world = async () => {
  seqCounter = 0;
  const h = await makeProjections();
  const adapter = createSearchRankAdapter({
    engine: h.engine,
    projections: h.projections,
    now: () => WALL + 20_000,
  });
  return { h, adapter };
};

const driveEvents = async (
  h: ProjectionHarness,
  events: readonly EventEnvelope[],
): Promise<void> => {
  await seedJournal(h, events);
  const applied = await h.projections.applyFromJournal(DEV_A);
  if (!applied.ok) throw new Error(`apply failed ${applied.error.code}`);
};

const mustReply = async (
  r: Promise<{ ok: boolean; value?: SearchRankReply }>,
): Promise<SearchRankReply> => {
  const out = await r;
  if (!out.ok || out.value === undefined) throw new Error('port returned err');
  return out.value;
};

describe('E5 adapter · availability is a value (never throws, never lies)', () => {
  it('an unbuilt index answers absent ⇒ the app falls back honestly', async () => {
    const { adapter } = await world();
    const reply = await mustReply(adapter.query({ q: 'pricing', scope: 'all', limit: 10 }));
    expect(reply.kind).toBe('unavailable');
    expect(reply.kind === 'unavailable' ? reply.reason : '').toBe('absent');
  });

  it('after indexing, queries answer ranked hits with fresh freshness', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [
      observe(1, 'Purple pricing table', 'https://acme.io/pricing/purple'),
      observe(2, 'Roadmap draft', 'https://acme.io/roadmap'),
      observe(3, 'Pricing caveats for sales', 'https://acme.io/blog/pricing'),
    ]);
    const reply = await mustReply(adapter.query({ q: 'pricing', scope: 'all', limit: 10 }));
    expect(reply.kind).toBe('ok');
    if (reply.kind !== 'ok') return;
    expect(reply.answer.freshness).toBe('fresh');
    const ids = reply.answer.hits.map((x) => x.tabId);
    expect(ids).toContain(tabId(1));
    expect(ids).toContain(tabId(3));
    expect(ids).not.toContain(tabId(2));
  });

  it('AND totality holds: every query term must appear in the doc', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [
      observe(1, 'Purple table', 'https://acme.io/p'),
      observe(2, 'Purple pricing table', 'https://acme.io/q'),
    ]);
    const reply = await mustReply(adapter.query({ q: 'purple pricing', scope: 'all', limit: 10 }));
    expect(reply.kind).toBe('ok');
    if (reply.kind !== 'ok') return;
    expect(reply.answer.hits.map((x) => x.tabId)).toEqual([tabId(2)]);
  });

  it('scope filters ride the index-side state', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [
      observe(1, 'Shared topic alpha', 'https://acme.io/a'),
      observe(2, 'Shared topic beta', 'https://acme.io/b'),
      ev('TabAssigned', { tabId: tabId(2), missionId: testId(90_001) }),
    ]);
    const open = await mustReply(adapter.query({ q: 'topic', scope: 'open', limit: 10 }));
    const kept = await mustReply(adapter.query({ q: 'topic', scope: 'kept', limit: 10 }));
    expect(open.kind === 'ok' ? open.answer.hits.map((x) => x.tabId) : []).toEqual([tabId(1)]);
    expect(kept.kind === 'ok' ? kept.answer.hits.map((x) => x.tabId) : []).toEqual([tabId(2)]);
  });

  it('tokenizer-mismatch is an unavailable answer, and ensureIndexFresh self-heals it', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [observe(1, 'Purple table', 'https://acme.io/p')]);
    // Sabotage the stamped version (a future tokenizer would stamp drift exactly so).
    await h.engine.txn(['search_index'], 'readwrite', async (tx) => {
      const row = await tx.table('search_index').get(SEARCH_STATS_KEY);
      const stats = row as { docs: number; totalLen: number; tokenizerV: number };
      await tx.table('search_index').put({ ...stats, tokenizerV: 999 });
      return undefined;
    });
    const bad = await mustReply(adapter.query({ q: 'purple', scope: 'all', limit: 10 }));
    expect(bad.kind).toBe('unavailable');
    expect(bad.kind === 'unavailable' ? bad.reason : '').toBe('tokenizer-mismatch');
    await adapter.ensureIndexFresh();
    const healed = await mustReply(adapter.query({ q: 'purple', scope: 'all', limit: 10 }));
    expect(healed.kind).toBe('ok');
    if (healed.kind !== 'ok') return;
    expect(healed.answer.hits.map((x) => x.tabId)).toEqual([tabId(1)]);
  });

  it('lag past the threshold flags the answer lagging (§2.11 correctness law)', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [observe(1, 'Purple table', 'https://acme.io/p')]);
    // Honest lag simulation: journal head far ahead of the index watermark.
    await h.engine.txn(['meta'], 'readwrite', async (tx) => {
      await tx.table('meta').put({
        key: META_JOURNAL_HEADS_KEY,
        value: { [DEV_A as string]: { lastSeq: 999_999, lastLamport: 0, openSegmentId: null } },
      });
      return undefined;
    });
    const reply = await mustReply(adapter.query({ q: 'purple', scope: 'all', limit: 10 }));
    expect(reply.kind).toBe('ok');
    if (reply.kind !== 'ok') return;
    expect(reply.answer.freshness).toBe('lagging');
    const f = await adapter.freshness();
    expect(f.ok && f.value.lag > 2000).toBe(true);
  });

  it('ranking honors recency and open-state boosts (live recent beats stale kept)', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [
      observe(1, 'Pricing', 'https://acme.io/alpha'),
      observe(2, 'Pricing', 'https://acme.io/beta'),
      ev('TabAssigned', { tabId: tabId(2), missionId: testId(90_002) }),
    ]);
    const reply = await mustReply(adapter.query({ q: 'pricing', scope: 'all', limit: 10 }));
    expect(reply.kind).toBe('ok');
    if (reply.kind !== 'ok') return;
    expect(reply.answer.hits[0]?.tabId).toBe(tabId(1));
  });

  it('dupesFor finds canon-hash twins; an unknown hash answers empty', async () => {
    const { h, adapter } = await world();
    await driveEvents(h, [
      observe(1, 'One', 'https://acme.io/same'),
      observe(2, 'Two', 'https://acme.io/same'),
      observe(3, 'Other', 'https://acme.io/different'),
    ]);
    const twinHash = canonicalize('https://acme.io/same').canonHash;
    const dupes = await adapter.dupesFor({ canonHash: twinHash });
    expect(dupes.ok).toBe(true);
    if (dupes.ok) expect([...dupes.value].sort()).toEqual([tabId(1), tabId(2)].sort());
    const loneHash = canonicalize('https://acme.io/different').canonHash;
    const lone = await adapter.dupesFor({ canonHash: loneHash });
    expect(lone.ok).toBe(true);
    if (lone.ok) expect(lone.value).toEqual([tabId(3)]);
    const unknown = await adapter.dupesFor({ canonHash: 'not-a-real-hash' });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.value).toEqual([]);
  });
});

describe('E5 adapter · rebuild determinism envelope', () => {
  it('engine rebuild reproduces query answers (deletable/rebuildable law §2.11)', async () => {
    const { h, adapter } = await world();
    const events = [
      observe(1, 'Purple pricing table', 'https://acme.io/pricing/purple'),
      observe(2, 'Pricing caveats', 'https://acme.io/blog/pricing'),
      observe(3, 'Unrelated', 'https://acme.io/other'),
    ];
    await driveEvents(h, events);
    const before = await mustReply(adapter.query({ q: 'pricing', scope: 'all', limit: 10 }));
    const rebuilt = await h.projections.rebuild('searchIndex');
    expect(rebuilt.ok).toBe(true);
    const after = await mustReply(adapter.query({ q: 'pricing', scope: 'all', limit: 10 }));
    expect(before).toEqual(after);
    expect(TOKENIZER_V).toBe(1);
  });
});
