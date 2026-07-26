// E3-APP · StreamAppender stamping-authority laws (EES §2.6/§2.8, E7 seq-collision law):
//  (1) serialized per device: N concurrent commits ⇒ unique contiguous seqs;
//  (2) lazy hydration: an untruth-seeded head ⇒ first stamp lands head+1;
//  (3) hinge co-writes commit with the same fate as their event batch (§5 law 2);
//  (4) bounded drift-retry converges a foreign (ingest-side) head bump;
//  (5) idempotent publish: same key + same content replays the cached ack, never doubles;
//  (6) applyProjections([]) is a free no-op (replays are cheap by design).
import { describe, expect, it } from 'vitest';
import { createStreamAppender } from '@/application/usecases/index.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';

const WALL_BASE_MS = 1_785_600_000_000;
const FOREIGN_EVENT_BASE = 9_900_000;

interface AppenderHarness {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly appender: ReturnType<typeof createStreamAppender>;
  readonly events: () => Promise<readonly EventEnvelope[]>;
  /** Foreign (ingest-side) stamped append — bypasses the appender memo on purpose. */
  readonly foreignAppend: (seq: number, type: string) => Promise<void>;
}

const makeAppender = async (): Promise<AppenderHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  let tick = 0;
  const ids = createIdGenerator({
    now: () => {
      tick += 1;
      return WALL_BASE_MS + tick;
    },
    randomBytes: (n: number) => new Uint8Array(n).fill(5),
  });
  const appender = createStreamAppender({
    journal,
    projections,
    deviceId: DEV_A,
    ids,
    now: () => WALL_BASE_MS + 1000 + tick,
  });
  return {
    engine,
    journal,
    appender,
    events: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error(`readRange failed: ${r.error.code}`);
      return [...r.value.events]
        .sort((a, b) => a.seq - b.seq || a.batchIndex - b.batchIndex)
        .map((e) => e.envelope);
    },
    foreignAppend: async (seq, type) => {
      void type;
      const env: EventEnvelope = {
        eventId: testId(FOREIGN_EVENT_BASE + seq) as EventEnvelope['eventId'],
        hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: WALL_BASE_MS + seq },
        type: 'SettingsChanged' as EventEnvelope['type'],
        payload: { key: `foreign-${seq}`, value: seq, schemaV: 1 } as EventEnvelope['payload'],
        producerContext: 'sw',
      };
      const r = await journal.append([env], {
        idempotencyKey: testId(FOREIGN_EVENT_BASE + 1_000 + seq),
      });
      if (!r.ok) throw new Error(`foreign append failed: ${r.error.code}`);
    },
  };
};

describe('E3-APP stream-appender — per-device stamping authority', () => {
  it('serializes concurrent commits: unique contiguous seqs, memo lands at N', async () => {
    const h = await makeAppender();
    const plan = (i: number) => ({
      type: 'SettingsChanged',
      payload: { key: `k-${i}`, value: i, schemaV: 1 },
    });
    const commits = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => h.appender.commit({ plans: [plan(i)], key: `k${i}` })),
    );
    for (const c of commits) expect(c.ok).toBe(true);
    const seqs = (await h.events()).map((e) => e.hlc.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(h.appender.headSeq()).toBe(5);
  });

  it('lazy hydration: a foreign-seeded head is respected (first stamp = head+1, never a fork)', async () => {
    const h = await makeAppender();
    await h.foreignAppend(1, 'SettingsChanged');
    await h.foreignAppend(2, 'SettingsChanged');
    const c = await h.appender.commit({
      plans: [{ type: 'SettingsChanged', payload: { key: 'k', value: 1, schemaV: 1 } }],
      key: 'hydrate',
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const last = (await h.events()).at(-1);
    expect(last?.hlc.seq).toBe(3);
    expect(h.appender.headSeq()).toBe(3);
  });

  it('hinge co-writes share the batch fate (§5 law 2): meta row + event land together', async () => {
    const h = await makeAppender();
    const c = await h.appender.commit({
      plans: [{ type: 'SettingsChanged', payload: { key: 'hk', value: 7, schemaV: 1 } }],
      key: 'hinge',
      hinge: {
        extraStores: ['meta'],
        write: async (tx) => {
          await tx.table('meta').put({ key: 'hinge.witness', value: 42 });
        },
      },
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect((await h.events()).length).toBe(1);
    const witness = await h.engine.txn(['meta'], 'readonly', (tx) =>
      tx.table('meta').get('hinge.witness'),
    );
    expect(witness.ok && witness.value?.['value']).toBe(42);
  });

  it('bounded drift-retry: a foreign head bump converges with a re-stamp (no fork, honest raw)', async () => {
    const h = await makeAppender();
    const first = await h.appender.commit({
      plans: [{ type: 'SettingsChanged', payload: { key: 'a', value: 1, schemaV: 1 } }],
      key: 'base',
    });
    expect(first.ok).toBe(true);
    // Ingest-side head bump the appender memo cannot know about.
    await h.foreignAppend(2, 'TabActivatedObserved');
    const second = await h.appender.commit({
      plans: [{ type: 'SettingsChanged', payload: { key: 'b', value: 2, schemaV: 1 } }],
      key: 'drifting',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const seqs = (await h.events()).map((e) => e.hlc.seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(second.value.ack.toSeq).toBe(3);
    expect(h.appender.headSeq()).toBe(3);
  });

  it('key-reuse law: same key with re-stamped content is a journal INTEGRITY red (never silent corruption)', async () => {
    const h = await makeAppender();
    const plans = [{ type: 'SettingsChanged', payload: { key: 'ik', value: 9, schemaV: 1 } }];
    const first = await h.appender.commit({ plans, key: 'idem' });
    expect(first.ok).toBe(true);
    // commit() re-stamps (fresh seq/eventIds) — the SAME key with alien bytes must
    // trip the journal's idempotency guardian (opKey-per-invocation is the seal).
    const reused = await h.appender.commit({ plans, key: 'idem' });
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error.code).toBe('E_JOURNAL_INTEGRITY');
    expect((await h.events()).length).toBe(1);
  });

  it('journal-level idempotency: a byte-identical replay rides the cached ack (M1 law, appender-facing)', async () => {
    const h = await makeAppender();
    const stamped: EventEnvelope = {
      eventId: testId(FOREIGN_EVENT_BASE + 777) as EventEnvelope['eventId'],
      hlc: { seq: 1, lamport: 1, deviceId: DEV_A, wallClock: WALL_BASE_MS + 1 },
      type: 'SettingsChanged' as EventEnvelope['type'],
      payload: { key: 'raw', value: 1, schemaV: 1 } as EventEnvelope['payload'],
      producerContext: 'sw',
    };
    const first = await h.journal.append([stamped], { idempotencyKey: 'rawkey' });
    expect(first.ok).toBe(true);
    const replay = await h.journal.append([stamped], { idempotencyKey: 'rawkey' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.count).toBe(first.ok ? first.value.count : -1);
    expect((await h.events()).length).toBe(1);
  });

  it('applyProjections([]) is a free no-op', async () => {
    const h = await makeAppender();
    const r = await h.appender.applyProjections([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.applied).toBe(0);
  });
});
