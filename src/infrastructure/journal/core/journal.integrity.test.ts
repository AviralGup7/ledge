// E2-T01 integrity suite — completion criteria as executable law:
//   "CRC walk detects seeded bit-flips at exact boundaries; tail scan ≤50ms."
// Every test seeds damage through the storage engine directly (no journal APIs), proving
// detection is a property of the durable bytes, not of the write path's good behavior.
import { describe, expect, it } from 'vitest';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { JournalSegmentRecord } from './types.js';
import { crcCoveredFields, verifySegmentCrc, withFreshCrc, newSegment } from './segment.js';
import {
  META_CHECKPOINT_KEY,
  META_JOURNAL_HEADS_KEY,
  SEGMENT_ENTRY_CAP,
  type DeviceStreamHead,
} from './types.js';
import { DEV_A as DEV, makeEnv as env, makeJournal, uniqueKey as batchKey } from './testkit.js';

type MetaRow = { key: string; value: unknown };

const SEG_CAP = SEGMENT_ENTRY_CAP;

const readSegments = async (engine: StorageEnginePort) => {
  const r = await engine.txn(['events'], 'readonly', (tx) =>
    tx.table<JournalSegmentRecord>('events').toArray(),
  );
  if (!r.ok) throw new Error('segments read failed');
  return r.value;
};

/** Re-write one segment with CRC-incoherent bytes (bit-rot / torn-write class). */
const rotSegment = async (
  engine: StorageEnginePort,
  segmentId: string,
  mutate: (s: JournalSegmentRecord) => Omit<JournalSegmentRecord, 'crc'>,
) => {
  const segs = await readSegments(engine);
  const target = segs.find((s) => s.segmentId === segmentId);
  if (target === undefined) throw new Error(`segment ${segmentId} missing`);
  const mutated = mutate(target) as JournalSegmentRecord;
  const r = await engine.txn(['events'], 'readwrite', (tx) => tx.table('events').put(mutated));
  if (!r.ok) throw new Error(`rot put failed: ${r.error.code}`);
};

const seedTwoSegments = async (): Promise<{
  engine: StorageEnginePort;
  journal: JournalPort;
  sealedId: string;
  openId: string;
}> => {
  const { engine, journal } = await makeJournal();
  // SEG_CAP+1 events: first segment sealed at cap, one entry in the open tail.
  const batch = Array.from({ length: SEG_CAP + 1 }, (_, i) => env(i + 1, i + 1));
  const r = await journal.append(batch.slice(0, SEG_CAP), { idempotencyKey: batchKey() });
  if (!r.ok) throw new Error('seed append failed');
  const r2 = await journal.append(batch.slice(SEG_CAP), { idempotencyKey: batchKey() });
  if (!r2.ok) throw new Error('seed tail append failed');
  const segs = await readSegments(engine);
  const sealed = segs.find((s) => s.sealed);
  const open = segs.find((s) => !s.sealed);
  if (sealed === undefined || open === undefined) throw new Error('seed shape wrong');
  return { engine, journal, sealedId: sealed.segmentId, openId: open.segmentId };
};

describe('E2-T01 CRC lifecycle (segment.ts pure core)', () => {
  it('every record field except crc is covered by the CRC image (format tripwire)', () => {
    const sample = newSegment(DEV, 1);
    const covered = new Set<string>(crcCoveredFields());
    for (const key of Object.keys(sample)) {
      if (key === 'crc') continue;
      expect(covered.has(key)).toBe(true);
    }
    expect(covered.size).toBe(Object.keys(sample).length - 1);
  });

  it('seal changes the image; both states self-verify', async () => {
    const { engine, journal } = await makeJournal();
    await journal.append([env(1, 1)], { idempotencyKey: batchKey() });
    const [open] = await readSegments(engine);
    if (open === undefined) throw new Error('missing segment');
    expect(verifySegmentCrc(open).ok).toBe(true);
    const sealed = withFreshCrc({ ...open, sealed: true });
    expect(sealed.crc).not.toBe(open.crc);
    expect(verifySegmentCrc(sealed).ok).toBe(true);
    await engine.close();
  });
});

describe('E2-T01 CRC walk detects seeded bit-flips at exact boundaries', () => {
  it('bit-flip in the LAST entry of the sealed boundary segment → suspect, exact segmentId', async () => {
    const { engine, journal, sealedId } = await seedTwoSegments();
    await rotSegment(engine, sealedId, (s) => ({
      ...s,
      entries: s.entries.map((e, i) =>
        i === s.entries.length - 1
          ? { ...e, event: { ...e.event, payload: { ...(e.event.payload as object), name: 'X' } } }
          : e,
      ),
    }));
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(report.value.status).toBe('suspect');
    const suspect = report.value.suspects.at(0);
    expect(suspect?.segmentId).toBe(sealedId);
    expect(suspect?.reason).toBe('crc-mismatch');
    await engine.close();
  });

  it('bit-flip in the FIRST entry of the open boundary segment → suspect, exact segmentId', async () => {
    const { engine, journal, openId } = await seedTwoSegments();
    await rotSegment(engine, openId, (s) => ({
      ...s,
      entries: s.entries.map((e, i) =>
        i === 0
          ? { ...e, event: { ...e.event, payload: { ...(e.event.payload as object), name: 'Y' } } }
          : e,
      ),
    }));
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(report.value.suspects.some((s) => s.segmentId === openId)).toBe(true);
    expect(report.value.suspects.at(0)?.reason).toBe('crc-mismatch');
    await engine.close();
  });

  it('a CRC-mismatched segment is never served by readRange (E_JOURNAL_INTEGRITY + segmentId)', async () => {
    const { engine, journal, sealedId } = await seedTwoSegments();
    await rotSegment(engine, sealedId, (s) => ({ ...s, sealed: false })); // residual: drift only
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe('E_JOURNAL_INTEGRITY');
      expect(read.error.details?.['segmentId']).toBe(sealedId);
    }
    await engine.close();
  });

  it('append refuses to extend a drifted open segment (crc verdict precedes anchor law)', async () => {
    const { engine, journal, openId } = await seedTwoSegments();
    await rotSegment(engine, openId, (s) => ({
      ...s,
      entries: s.entries.map((e, i) => (i === 0 ? { ...e, batchIndex: 3 } : e)),
    }));
    const r = await journal.append([env(SEG_CAP + 2, SEG_CAP + 2)], {
      idempotencyKey: batchKey(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['raw']).toBe('segment-crc-mismatch');
    await engine.close();
  });
});

describe('E2-T01 chain/seal/head laws (CRC-consistent sabotage)', () => {
  it('heads anchor drift (lastSeq advanced without bytes) → suspect head-drift', async () => {
    const { engine, journal } = await seedTwoSegments();
    const r = await engine.txn(['meta'], 'readwrite', async (tx) => {
      const meta = tx.table<MetaRow>('meta');
      const row = await meta.get(META_JOURNAL_HEADS_KEY);
      const heads = (row?.value ?? {}) as Record<string, DeviceStreamHead>;
      const dev = heads[DEV as string];
      if (dev !== undefined) heads[DEV as string] = { ...dev, lastSeq: dev.lastSeq + 7 };
      await meta.put({ key: META_JOURNAL_HEADS_KEY, value: heads });
      return true;
    });
    if (!r.ok) throw new Error('heads tamper failed');
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(report.value.suspects.some((s) => s.reason === 'head-drift')).toBe(true);
    await engine.close();
  });

  it('unsealed non-final segment (re-stammped CRC) → suspect seal-law', async () => {
    const { engine, journal, sealedId } = await seedTwoSegments();
    await rotSegment(engine, sealedId, (s) => withFreshCrc({ ...s, sealed: false }));
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(
      report.value.suspects.some((s) => s.segmentId === sealedId && s.reason === 'seal-law'),
    ).toBe(true);
    await engine.close();
  });

  it('deleted open segment → chain gap cannot hide (chain-sequence suspect)', async () => {
    const { engine, journal } = await makeJournal();
    for (let b = 0; b < 3; b++) {
      const batch = Array.from({ length: 10 }, (_, i) => env(b * 10 + i + 1, b * 10 + i + 1));
      const r = await journal.append(batch, { idempotencyKey: batchKey() });
      if (!r.ok) throw new Error('append failed');
    }
    // 30 entries live in ONE open segment; erasing it leaves heads pointing at bytes
    // that no longer exist — the walk must prosecute, not infer.
    const segs = await readSegments(engine);
    const tail = segs.find((s) => !s.sealed);
    if (tail === undefined) throw new Error('no open tail');
    const d = await engine.txn(['events'], 'readwrite', (tx) =>
      tx.table('events').delete(tail.segmentId),
    );
    if (!d.ok) throw new Error('delete failed');
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(report.value.suspects.some((s) => s.reason === 'chain-sequence')).toBe(true);
    await engine.close();
  });

  it('lamport regression inside a re-stammped segment → suspect lamport-regression', async () => {
    const { engine, journal } = await makeJournal();
    const r = await journal.append([env(1, 5), env(2, 6), env(3, 7)], {
      idempotencyKey: batchKey(),
    });
    if (!r.ok) throw new Error('append failed');
    const segs = await readSegments(engine);
    const only = segs.at(0);
    if (only === undefined) throw new Error('no segment');
    await rotSegment(engine, only.segmentId, (s) =>
      withFreshCrc({
        ...s,
        entries: s.entries.map((e, i) =>
          i === 2 ? { ...e, event: { ...e.event, hlc: { ...e.event.hlc, lamport: 2 } } } : e,
        ),
      }),
    );
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(report.value.suspects.some((s) => s.reason === 'lamport-regression')).toBe(true);
    await engine.close();
  });

  it('unknown segment format → suspect format-unknown, no interpretation attempted', async () => {
    const { engine, journal, openId } = await seedTwoSegments();
    await rotSegment(engine, openId, (s) => withFreshCrc({ ...s, formatV: 99 }));
    const report = await journal.scanFull();
    if (!report.ok) throw new Error('scanFull failed');
    expect(
      report.value.suspects.some((s) => s.segmentId === openId && s.reason === 'format-unknown'),
    ).toBe(true);
    await engine.close();
  });
});

describe('E2-T01 checkpoints (EES §2.8 invariant: restorable, zero replay)', () => {
  it('stamps checkpointPtrs per device; idempotent; zero-replay hold (journal untouched)', async () => {
    const { engine, journal } = await makeJournal();
    for (let i = 1; i <= 3; i += 1) {
      const r = await journal.append([env(i, i)], { idempotencyKey: batchKey() });
      if (!r.ok) throw new Error('append failed');
    }
    const first = await journal.checkpoint();
    if (!first.ok) throw new Error(`checkpoint failed: ${first.error.code}`);
    expect(first.value.stamped).toHaveLength(1);
    const stamp = first.value.stamped.at(0);
    expect(stamp?.deviceId).toBe(DEV);
    expect(stamp?.throughSeq).toBe(3);

    const second = await journal.checkpoint();
    if (!second.ok) throw new Error('re-checkpoint failed');
    expect(second.value.stamped).toEqual(first.value.stamped);

    // Zero-replay hold: nothing was deleted or rewritten — the full stream still reads.
    const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
    if (!read.ok) throw new Error('read failed');
    expect(read.value.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // Meta carries the pointer row, exactly as EES §5's inventory demands.
    const meta = await engine.txn(['meta'], 'readonly', (tx) =>
      tx.table<MetaRow>('meta').get(META_CHECKPOINT_KEY),
    );
    if (!meta.ok || meta.value === undefined) throw new Error('ptr row missing');
    await engine.close();
  });

  it('refuses to stamp over suspect bytes (no lie about restorability)', async () => {
    const { engine, journal, sealedId } = await seedTwoSegments();
    await rotSegment(engine, sealedId, (s) => ({ ...s, sealed: false })); // residual: drift only
    const attempt = await journal.checkpoint();
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.error.code).toBe('E_JOURNAL_INTEGRITY');
      expect(attempt.error.details?.['segmentId']).toBe(sealedId);
    }
    // The refusal is write-free: no pointer row may exist on this fresh journal.
    const after = await engine.txn(['meta'], 'readonly', (tx) =>
      tx.table<MetaRow>('meta').get(META_CHECKPOINT_KEY),
    );
    expect(after.ok && after.value === undefined).toBe(true);
    await engine.close();
  });

  it('empty journal checkpoints as a no-op (stamped: [])', async () => {
    const { engine, journal } = await makeJournal();
    const r = await journal.checkpoint();
    if (!r.ok) throw new Error('checkpoint failed');
    expect(r.value.stamped).toEqual([]);
    const scan = await journal.scanFull();
    if (!scan.ok) throw new Error('scan failed');
    expect(scan.value.status).toBe('ok');
    expect(scan.value.devices).toEqual([]);
    await engine.close();
  });
});

describe('E2-T01 tail scans (WAL design: post-checkpoint window only)', () => {
  it('damage BELOW the checkpoint is outside the tail window; above it is caught', async () => {
    const { engine, journal } = await makeJournal();
    for (let i = 1; i <= 4; i += 1) {
      const r = await journal.append([env(i, i)], { idempotencyKey: batchKey() });
      if (!r.ok) throw new Error('append failed');
    }
    const cp = await journal.checkpoint();
    if (!cp.ok) throw new Error('checkpoint failed');
    const segs = await readSegments(engine);
    const only = segs.at(0);
    if (only === undefined) throw new Error('no segment');

    // Rot a pre-checkpoint entry: tail scan stays green (window starts at seq 5),
    // the full walk prosecutes it.
    await rotSegment(engine, only.segmentId, (s) => ({
      ...s,
      entries: s.entries.map((e, i) => (i === 0 ? { ...e, batchIndex: 7 } : e)),
    }));
    const tail = await journal.scanTail();
    if (!tail.ok) throw new Error('scanTail failed');
    expect(tail.value.status).toBe('ok');
    expect(tail.value.coverage).toBe('tail');
    const full = await journal.scanFull();
    if (!full.ok) throw new Error('scanFull failed');
    expect(full.value.status).toBe('suspect');

    // Restore the pristine bytes (recovery replayed them, say), then append
    // post-checkpoint bytes and rot THOSE: the tail walk must catch it.
    const restore = await engine.txn(['events'], 'readwrite', (tx) => tx.table('events').put(only));
    if (!restore.ok) throw new Error('restore failed');
    const r5 = await journal.append([env(5, 5)], { idempotencyKey: batchKey() });
    if (!r5.ok) throw new Error('post-checkpoint append failed');
    await rotSegment(engine, only.segmentId, (s) => ({
      ...s,
      entries: s.entries.map((e, i) => (i === s.entries.length - 1 ? { ...e, batchIndex: 9 } : e)),
    }));
    const tail2 = await journal.scanTail();
    if (!tail2.ok) throw new Error('scanTail 2 failed');
    expect(tail2.value.status).toBe('suspect');
    await engine.close();
  });

  it('steady-state tail scan completes within 50ms (E2-T01 completion law)', async () => {
    const { engine, journal } = await makeJournal();
    // Three full sealed segments (1500 entries) + checkpoint, then 200 post-checkpoint
    // entries — the steady-state window a wake actually scans.
    for (let b = 0; b < 3; b += 1) {
      const batch = Array.from({ length: SEG_CAP }, (_, i) => {
        const seq = b * SEG_CAP + i + 1;
        return env(seq, seq);
      });
      const r = await journal.append(batch, { idempotencyKey: batchKey() });
      if (!r.ok) throw new Error('seed append failed');
    }
    const cp = await journal.checkpoint();
    if (!cp.ok) throw new Error('checkpoint failed');
    const tailBatch = Array.from({ length: 200 }, (_, i) => env(1501 + i, 1501 + i));
    const rt = await journal.append(tailBatch, { idempotencyKey: batchKey() });
    if (!rt.ok) throw new Error('tail append failed');

    const started = performance.now();
    const scan = await journal.scanTail();
    const elapsed = performance.now() - started;
    if (!scan.ok) throw new Error('scanTail failed');
    expect(scan.value.status).toBe('ok');
    expect(elapsed).toBeLessThan(50);
    await engine.close();
  });
});
