// E1-T10 unit tests — append→readRange round trip in CI (roadmap completion criterion)
// plus the §2.8/§2.2 integrity, retry, and forward-tolerance laws.
import { describe, expect, it } from 'vitest';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import {
  DEV_A as DEV,
  DEV_B as DEV2,
  makeEnv as env,
  makeEngine,
  makeJournal,
  uniqueKey as batchKey,
} from './testkit.js';
import { createJournalAppender } from '../index.js';
import { withFreshCrc } from './segment.js';
import {
  META_JOURNAL_HEADS_KEY,
  type DeviceStreamHead,
  type JournalSegmentRecord,
} from './types.js';

const opened = makeJournal;

const readSegments = async (
  engine: StorageEnginePort,
): Promise<readonly JournalSegmentRecord[]> => {
  const r = await engine.txn(['events'], 'readonly', (tx) =>
    tx.table<JournalSegmentRecord>('events').toArray(),
  );
  if (!r.ok) throw new Error('segment read failed');
  return r.value;
};

const firstSegment = async (engine: StorageEnginePort): Promise<JournalSegmentRecord> => {
  const s = (await readSegments(engine)).at(0);
  if (s === undefined) throw new Error('expected at least one segment');
  return s;
};

describe('E1-T10 journal appender core', () => {
  it('append -> readRange round trip: envelopes return intact and ordered', async () => {
    const { journal, engine } = await opened();
    const batch = [env(1, 1), env(2, 2), env(3, 2)]; // lamport ties allowed, never decreases
    const ack = await journal.append(batch, { idempotencyKey: batchKey() });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.value).toMatchObject({ deviceId: DEV, fromSeq: 1, toSeq: 3, count: 3 });

    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.durableThrough).toBe(3);
    expect(read.value.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(read.value.events.map((e) => e.batchIndex)).toEqual([0, 1, 2]);
    expect(read.value.events[0]?.envelope).toEqual(batch[0]);
    expect(read.value.preservedUnknown).toEqual([]);
    await engine.close();
  });

  it('post-law: acked events appear in readRange monotonically across batches', async () => {
    const { journal, engine } = await opened();
    await journal.append([env(1, 1), env(2, 2)], { idempotencyKey: batchKey() });
    await journal.append([env(3, 3)], { idempotencyKey: batchKey() });
    await journal.append([env(4, 4), env(5, 5), env(6, 6)], { idempotencyKey: batchKey() });
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(read.value.durableThrough).toBe(6);
    await engine.close();
  });

  it('retry law: same idempotency key replays the ack and writes nothing new', async () => {
    const { journal, engine } = await opened();
    const key = batchKey();
    const b = [env(1, 1), env(2, 2)];
    const first = await journal.append(b, { idempotencyKey: key });
    const second = await journal.append(b, { idempotencyKey: key });
    if (!first.ok || !second.ok) throw new Error('append failed');
    expect(second.value).toEqual(first.value);
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events).toHaveLength(2);
    expect(read.value.durableThrough).toBe(2);
    await engine.close();
  });

  it('retry law guard: same key with different content is a hard integrity violation', async () => {
    const { journal, engine } = await opened();
    const key = batchKey();
    await journal.append([env(1, 1)], { idempotencyKey: key });
    const alien = await journal.append([env(99, 99)], { idempotencyKey: key });
    expect(alien.ok).toBe(false);
    if (!alien.ok) expect(alien.error.details?.['raw']).toBe('idempotency-key-reuse');
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.durableThrough).toBe(1); // the original, untouched
    await engine.close();
  });

  it('integrity: seq gap vs head rejected; nothing written', async () => {
    const { journal, engine } = await opened();
    await journal.append([env(1, 1)], { idempotencyKey: batchKey() });
    const gap = await journal.append([env(3, 2)], { idempotencyKey: batchKey() });
    expect(gap.ok).toBe(false);
    if (gap.ok) return;
    expect(gap.error.code).toBe('E_JOURNAL_INTEGRITY');
    expect(gap.error.details?.['expected']).toBe(2);
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.durableThrough).toBe(1);
    await engine.close();
  });

  it('integrity: in-batch non-contiguous seq rejected even against empty stream', async () => {
    const { journal, engine } = await opened();
    const r = await journal.append([env(1, 1), env(3, 2)], { idempotencyKey: batchKey() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['raw']).toBe('seq-not-contiguous');
    await engine.close();
  });

  it('integrity: cross-device batch rejected', async () => {
    const { journal, engine } = await opened();
    const r = await journal.append([env(1, 1, DEV), env(2, 2, DEV2)], {
      idempotencyKey: batchKey(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['raw']).toBe('cross-device-batch');
    await engine.close();
  });

  it('integrity: lamport regression rejected in-batch and vs head (EES §2.2)', async () => {
    const { journal, engine } = await opened();
    const inBatch = await journal.append([env(1, 5), env(2, 4)], { idempotencyKey: batchKey() });
    expect(inBatch.ok).toBe(false);
    if (!inBatch.ok) expect(inBatch.error.details?.['raw']).toBe('lamport-regression');

    await journal.append([env(1, 5)], { idempotencyKey: batchKey() });
    const vsHead = await journal.append([env(2, 4)], { idempotencyKey: batchKey() });
    expect(vsHead.ok).toBe(false);
    if (!vsHead.ok) expect(vsHead.error.details?.['raw']).toBe('lamport-regression-vs-head');
    await engine.close();
  });

  it('integrity: empty batch and empty idempotency key rejected', async () => {
    const { journal, engine } = await opened();
    const empty = await journal.append([], { idempotencyKey: batchKey() });
    expect(empty.ok).toBe(false);
    const noKey = await journal.append([env(1, 1)], { idempotencyKey: '  ' });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error.details?.['raw']).toBe('idempotency-key-empty');
    await engine.close();
  });

  it('strict write: unregistered event types are rejected at append', async () => {
    const { journal, engine } = await opened();
    const alien: EventEnvelope = { ...env(1, 1), type: 'NotARegisteredType' };
    const r = await journal.append([alien], { idempotencyKey: batchKey() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_FORMAT_UNKNOWN');
    await engine.close();
  });

  it('tolerant read (ADR-033): unknown type and future version pass through preserved', async () => {
    const { journal, engine } = await opened();
    await journal.append([env(1, 1), env(2, 2)], { idempotencyKey: batchKey() });
    // Craft a future/foreign entry directly into the open segment (as a future build would).
    const s = await firstSegment(engine);
    const alienType = {
      ...env(3, 3),
      type: 'FutureV2Type',
      payload: { something: 'new' },
    } as unknown as EventEnvelope;
    const futureVer = env(4, 4);
    // A coherent future build checksummed its own bytes (as the appender would).
    const mutated: JournalSegmentRecord = withFreshCrc({
      ...s,
      entries: [
        ...s.entries,
        { seq: 3, batchIndex: 0, v: 1, event: alienType },
        { seq: 4, batchIndex: 0, v: 99, event: futureVer },
      ],
    });
    // A coherent future build writes entries + head atomically (like the appender does);
    // entries beyond the head horizon are a torn tail and must stay invisible (§2.8).
    await engine.txn(['events', 'meta'], 'readwrite', async (tx) => {
      await tx.table('events').put(mutated);
      const metaRow = await tx
        .table<{ key: string; value: unknown }>('meta')
        .get(META_JOURNAL_HEADS_KEY);
      const heads = (metaRow?.value ?? {}) as Record<string, DeviceStreamHead>;
      heads[DEV as string] = { lastSeq: 4, lastLamport: 4, openSegmentId: s.segmentId };
      await tx.table('meta').put({ key: META_JOURNAL_HEADS_KEY, value: heads });
    });

    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(read.value.preservedUnknown.map((p) => [p.seq, p.reason])).toEqual([
      [3, 'type'],
      [4, 'version'],
    ]);
    // Preserved rows keep their frozen stored form (never dropped, never mutated).
    expect(read.value.preservedUnknown[0]?.stored.event.type).toBe('FutureV2Type');
    expect(read.value.preservedUnknown[1]?.stored.v).toBe(99);
    await engine.close();
  });

  it('torn-tail protection: entries beyond the head horizon never surface in reads', async () => {
    const { journal, engine } = await opened();
    await journal.append([env(1, 1), env(2, 2)], { idempotencyKey: batchKey() });
    // Simulate a torn write: an entry landed in a segment but the head anchor never
    // advanced (kill between segment write and head write WITHOUT a shared txn — the
    // failure class the single-txn hinge makes impossible; defense in depth anyway).
    // foreign write. The bytes checksum fine (a writer that knew the format); the head
    // anchor never advanced — the defense this test pins.
    const s = await firstSegment(engine);
    await engine.txn(['events'], 'readwrite', (tx) =>
      tx.table('events').put(
        withFreshCrc({
          ...s,
          entries: [...s.entries, { seq: 3, batchIndex: 0, v: 1, event: env(3, 3) }],
        }),
      ),
    );
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(read.value.durableThrough).toBe(2);
    await engine.close();
  });

  it('readRange windows: [fromSeq, toSeq] inclusive at both ends', async () => {
    const { journal, engine } = await opened();
    for (let i = 1; i <= 5; i++) {
      await journal.append([env(i, i)], { idempotencyKey: batchKey() });
    }
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 2, toSeq: 4 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events.map((e) => e.seq)).toEqual([2, 3, 4]);
    const invalid = await journal.readRange({ deviceId: DEV, fromSeq: 4, toSeq: 2 });
    expect(invalid.ok).toBe(false);
    await engine.close();
  });

  it('unknown device stream reads empty with durableThrough 0', async () => {
    const { journal, engine } = await opened();
    await journal.append([env(1, 1)], { idempotencyKey: batchKey() });
    const read = await journal.readRange({ deviceId: DEV2, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events).toEqual([]);
    expect(read.value.durableThrough).toBe(0);
    await engine.close();
  });

  it('rollover: segment seals at cap and the stream continues in a fresh segment', async () => {
    const { journal, engine } = await opened();
    const HALF = 250; // four batches of 250 cross the 500-entry cap exactly once
    for (let b = 0; b < 4; b++) {
      const batch = Array.from({ length: HALF }, (_, i) => {
        const seq = b * HALF + i + 1;
        return env(seq, seq);
      });
      const r = await journal.append(batch, { idempotencyKey: batchKey() });
      if (!r.ok) throw new Error(`append failed at batch ${b}: ${r.error.code}`);
    }
    const segs = await readSegments(engine);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.sealed).toBe(true);
    expect(segs[0]?.entries).toHaveLength(500);
    expect(segs[1]?.sealed).toBe(false);
    expect(segs[1]?.entries).toHaveLength(500);
    expect(segs[1]?.seqStart).toBe(501);
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events).toHaveLength(1000);
    expect(read.value.events[999]?.seq).toBe(1000);
    await engine.close();
  });

  it('sealed segments immutable: a drifted sealed-open head is an integrity violation', async () => {
    const { journal, engine } = await opened();
    await journal.append([env(1, 1)], { idempotencyKey: batchKey() });
    // Corrupt: flip the open segment to sealed out from under the head anchor — as a
    // coherent tamper (CRC re-stamped) so the anchor law itself, not the checksum, fires.
    const s = await firstSegment(engine);
    await engine.txn(['events'], 'readwrite', (tx) =>
      tx.table('events').put(withFreshCrc({ ...s, sealed: true })),
    );
    const r = await journal.append([env(2, 2)], { idempotencyKey: batchKey() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['raw']).toBe('head-segment-sealed');
    await engine.close();
  });

  it('journal requires an opened engine (L6 discipline inherited)', async () => {
    const engine = makeEngine();
    const journal = createJournalAppender(engine);
    const r = await journal.append([env(1, 1)], { idempotencyKey: batchKey() });
    expect(r.ok).toBe(false);
    const read = await journal.readRange({ deviceId: DEV as DeviceId, fromSeq: 1 });
    expect(read.ok).toBe(false);
    await engine.close();
  });
});
