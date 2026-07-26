// E5-T01 · Search-index projector laws — term/registry/stats discipline across the
// mirrored tabs lifecycle (observe→assign→activate→update→close→trash→restore→purge),
// the zero-op law, stats balance, and the registry-survives-trash restore seam.
// Driven directly (journal-level determinism is the engine's property suite).
import { describe, expect, it } from 'vitest';
import type { DeltaOp } from '@/application/ports/projection-engine.port.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { DEV_A, testId } from '@/infrastructure/projections/testkit.js';
import type { PostingEntry } from './ranker.js';
import { registryKeyOf, SEARCH_STATS_KEY, searchIndexProjector } from './index.projector.js';
import { TOKENIZER_V } from './tokenizer.js';

const WALL = 1_950_000_000_000;
const TAB = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MISSION = '01BX5ZZKBKACTAV9WEVGEMMVRY';

// Honest envelope factory (monotonic per-file seq): the projector reads
// type/payload/hlc.wallClock only, but fixtures mirror the real wire shape.
let seq = 0;
const event = (
  type: string,
  payload: Readonly<Record<string, unknown>>,
  wall = WALL,
): EventEnvelope => {
  seq += 1;
  return {
    eventId: testId(60_000 + seq) as EventEnvelope['eventId'],
    hlc: { seq, lamport: seq, deviceId: DEV_A as DeviceId, wallClock: wall },
    type: type as EventEnvelope['type'],
    payload: payload as EventEnvelope['payload'],
    producerContext: 'sw',
  };
};

/** Drive the projector over an in-memory map, materializing ops like the engine does. */
const drive = () => {
  const store = new Map<string, StoredRecord>();
  const apply = async (e: EventEnvelope): Promise<readonly DeltaOp[]> => {
    const read = async (key: string): Promise<StoredRecord | undefined> => store.get(key);
    const ops = await searchIndexProjector.project(e, read);
    for (const op of ops) {
      if (op.kind === 'upsert') store.set(op.key, { ...op.record });
      if (op.kind === 'remove') store.delete(op.key);
      if (op.kind === 'patch') {
        const cur = store.get(op.key) ?? {};
        store.set(op.key, { ...cur, ...op.fields, token: op.key });
      }
    }
    return ops;
  };
  const postingsOfTerm = (term: string): readonly PostingEntry[] => {
    const row = store.get(term);
    return row !== undefined && Array.isArray(row['p']) ? (row['p'] as PostingEntry[]) : [];
  };
  const stats = (): { docs: number; totalLen: number; tokenizerV: number } | undefined =>
    store.get(SEARCH_STATS_KEY) as
      { docs: number; totalLen: number; tokenizerV: number } | undefined;
  const registry = (tabId: string) => store.get(registryKeyOf(tabId));
  return { apply, store, postingsOfTerm, stats, registry };
};

const observe = (tabId: string, title: string, url: string, ts = WALL): EventEnvelope =>
  event('TabObserved', { ledgeTabId: tabId, title, url, domain: 'acme.io', ts });

describe('E5 projector · term + stats discipline', () => {
  it('TabObserved indexes title/url/domain tokens with postings, registry, stats', async () => {
    const h = drive();
    const ops = await h.apply(
      observe(TAB, 'Purple pricing table', 'https://acme.io/pricing/purple'),
    );
    expect(ops.length).toBeGreaterThan(0);
    expect(h.postingsOfTerm('purple')[0]?.id).toBe(TAB);
    expect(h.postingsOfTerm('pricing')[0]?.st).toBe('live');
    expect(h.postingsOfTerm('acme').length).toBe(1);
    expect(h.registry(TAB)?.['st']).toBe('live');
    expect(h.stats()?.docs).toBe(1);
    expect(h.stats()?.tokenizerV).toBe(TOKENIZER_V);
    expect((h.stats()?.totalLen ?? 0) > 0).toBe(true);
  });

  it('the zero-op law: replaying the same observation emits nothing', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    const replay = await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    expect(replay.length).toBe(0);
  });

  it('TabUpdated retokenizes: stale terms drain, new terms gain the doc', async () => {
    const h = drive();
    // URL path tokens must NOT collide with title words, or the drain assertion
    // would conflate the two sources (url tokens correctly survive a title swap).
    await h.apply(observe(TAB, 'Old brief', 'https://acme.io/entry'));
    await h.apply(event('TabUpdated', { ledgeTabId: TAB, changes: { title: 'New roadmap' } }));
    expect(h.postingsOfTerm('old').length).toBe(0);
    expect(h.postingsOfTerm('brief').length).toBe(0);
    expect(h.postingsOfTerm('roadmap')[0]?.id).toBe(TAB);
    expect(h.postingsOfTerm('acme').length).toBe(1); // url tokens survive
    expect(h.postingsOfTerm('entry').length).toBe(1);
  });

  it('a term row drains to removal (never an empty-postings ghost)', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Unique lonelytoken', 'https://acme.io/x'));
    await h.apply(event('TabClosedExternal', { ledgeTabId: TAB }));
    expect(h.store.has('lonelytoken')).toBe(false);
    expect(h.store.has('token-ghost')).toBe(false);
    expect(h.registry(TAB)).toBeUndefined();
    expect(h.stats()?.docs).toBe(0);
  });
});

describe('E5 projector · lifecycle mirror', () => {
  it('TabAssigned is the only KEPT producer (MissionFormed does not stamp)', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    await h.apply(event('MissionFormed', { missionId: MISSION, tabIds: [TAB] }));
    expect(h.postingsOfTerm('purple')[0]?.st).toBe('live');
    await h.apply(event('TabAssigned', { tabId: TAB, missionId: MISSION }));
    expect(h.postingsOfTerm('purple')[0]?.st).toBe('kept');
  });

  it('TabActivatedObserved refreshes recency (posting la), zero-op on same stamp', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    const noop = await h.apply(event('TabActivatedObserved', { ledgeTabId: TAB, ts: WALL }));
    expect(noop.length).toBe(0);
    await h.apply(event('TabActivatedObserved', { ledgeTabId: TAB, ts: WALL + 5000 }));
    expect(h.postingsOfTerm('purple')[0]?.la).toBe(WALL + 5000);
  });

  it('TabClosedExternal kills only LIVE docs; a KEPT doc is stickier than a close', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    await h.apply(event('TabAssigned', { tabId: TAB, missionId: MISSION }));
    const ops = await h.apply(event('TabClosedExternal', { ledgeTabId: TAB }));
    expect(ops.length).toBe(0);
    expect(h.postingsOfTerm('purple').length).toBe(1);
  });

  it('trash drops postings but the registry SURVIVES; restore re-materializes as kept', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    await h.apply(event('EntityTrashed', { kind: 'tab', id: TAB, deletedAt: WALL }));
    expect(h.postingsOfTerm('purple').length).toBe(0);
    expect(h.stats()?.docs).toBe(0);
    expect(h.registry(TAB)?.['st']).toBe('trash');
    await h.apply(event('TrashRestored', { kind: 'tab', id: TAB }));
    expect(h.postingsOfTerm('purple')[0]?.st).toBe('kept');
    expect(h.stats()?.docs).toBe(1);
  });

  it('purge removes the registry too; stats stay balanced at zero', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    await h.apply(event('EntityTrashed', { kind: 'tab', id: TAB, deletedAt: WALL }));
    await h.apply(event('TrashPurged', { kind: 'tab', id: TAB }));
    expect(h.registry(TAB)).toBeUndefined();
    expect(h.stats()?.docs).toBe(0);
    expect(h.stats()?.totalLen).toBe(0);
  });

  it('MissionResumed flips kept docs back to live postings', async () => {
    const h = drive();
    await h.apply(observe(TAB, 'Purple table', 'https://acme.io/p'));
    await h.apply(event('TabAssigned', { tabId: TAB, missionId: MISSION }));
    await h.apply(
      event('MissionResumed', { restoredMapping: { windowId: 3, tabs: [{ tabId: TAB }] } }),
    );
    expect(h.postingsOfTerm('purple')[0]?.st).toBe('live');
  });

  it('ImportCommitted indexes manifest tabs as kept in one fan-out', async () => {
    const h = drive();
    await h.apply(
      event('ImportCommitted', {
        batchManifestRef: {
          missions: [
            {
              missionId: MISSION,
              tabs: [
                {
                  ledgeTabId: TAB,
                  url: 'https://acme.io/imported',
                  title: 'Imported tab',
                  domain: 'acme.io',
                },
              ],
            },
          ],
        },
      }),
    );
    expect(h.postingsOfTerm('imported')[0]?.st).toBe('kept');
    expect(h.stats()?.docs).toBe(1);
  });

  it('stats math balances across two docs and removals (never negative)', async () => {
    const h = drive();
    const TAB2 = '01C6GQDCC7G5B0R8KJRDBB1KYZ';
    await h.apply(observe(TAB, 'Alpha beta', 'https://a.io/1'));
    await h.apply(observe(TAB2, 'Gamma delta', 'https://b.io/2'));
    const total = h.stats()?.totalLen ?? 0;
    await h.apply(event('TabClosedExternal', { ledgeTabId: TAB }));
    expect(h.stats()?.docs).toBe(1);
    expect((h.stats()?.totalLen ?? -1) < total).toBe(true);
    await h.apply(event('TabClosedExternal', { ledgeTabId: TAB2 }));
    expect(h.stats()?.totalLen).toBe(0);
    expect(h.stats()?.docs).toBe(0);
  });
});
