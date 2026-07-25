// E2-T11 compact test fixtures. TEST-ONLY (same dep-policy discipline as
// core/testkit.ts). Twin-world determinism law: every seeding uses FIXED
// idempotency keys and clock-free envelopes, so two engines seeded with the
// same world snapshot byte-identically — the resume-equivalence laws compare
// a killed+resumed world against an uninterrupted twin byte for byte.
import type { CompactionPlan, PurgeChainRef } from '@/application/ports/journal.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type {
  StorageEnginePort,
  StoreHandle,
  StoreName,
  StoredRecord,
  TxScope,
  TxnMode,
} from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { withFreshCrc } from '../core/segment.js';
import {
  META_PURGE_EPOCH_KEY,
  SEGMENT_ENTRY_CAP,
  type CompactionBaseline,
  type JournalSegmentRecord,
} from '../core/types.js';
import { DEV_A, DEV_B, makeEnv, testId } from '../core/testkit.js';
import {
  CHUNK_SEGMENTS_DEFAULT,
  EMPTY_EXCLUDED_DIGEST,
  chunkWindow,
  digestOfPlan,
  excludeEntries,
  foldExcludedInto,
  windowSegments,
} from './policy.js';

// ---------------------------------------------------------------------------
// Kill-point registry (third chaos owner — see ops/chaos/points.txt note).
// ---------------------------------------------------------------------------

/**
 * compact.segment-rewrite.mid — kill after some-but-not-all chunk txns: the
 *   durable image is a running baseline at a mid-window cursor plus a prefix
 *   of the segment rewrites.
 * compact.baseline-flip.before — all chunks applied, status flip never
 *   happened: running baseline with an exhausted (null) cursor.
 * compact.checkpoint.mid — baseline flipped done, checkpoint restamp never
 *   ran: `meta.checkpointPtrs` still points at pre-compaction bytes.
 */
export const COMPACT_KILL_POINTS = [
  'compact.segment-rewrite.mid',
  'compact.baseline-flip.before',
  'compact.checkpoint.mid',
] as const;

// ---------------------------------------------------------------------------
// World factories (deterministic twins).
// ---------------------------------------------------------------------------

/** missionId carried by makeEnv's MissionRenamed payload at seq (core testkit salt). */
const MISSION_ID_SALT = 9000;
export const missionIdForSeq = (seq: number): string => testId(MISSION_ID_SALT + seq);

/** Envelope whose payload references one explicit mission id (trash fixtures). */
export const makeTrashEnv = (
  seq: number,
  lamport: number,
  missionId: string,
  deviceId: DeviceId = DEV_A,
): EventEnvelope => ({
  eventId: testId(seq) as EventEnvelope['eventId'],
  hlc: { seq, lamport, deviceId, wallClock: 0 },
  type: 'MissionRenamed',
  payload: { missionId, name: `trashed-${seq}`, namedBy: 'user' },
  producerContext: 'sw',
});

export const WORLD_TAIL_ENTRIES = 17;

/** Canonical world's sealed-segment count (three SEGMENT_ENTRY_CAP batches). */
const CANONICAL_SEALED_BATCHES = 3;
/** Full-exclusion world's total sealed segments (trash batch + clean batches). */
const TRASH_WORLD_SEALED_BATCHES = 3;
/** makePlan's default exclusion target (a seq inside the first sealed segment). */
const PLAN_TARGET_SEQ_DEFAULT = 7;

/** Fixed idempotency keys — twin worlds must land journal.idem.* rows identically. */
const SEED_KEY_PREFIX = 'compact-seed';

const appendBatch = async (
  journal: JournalPort,
  batch: readonly EventEnvelope[],
  keyIndex: number,
): Promise<void> => {
  const r = await journal.append(batch, {
    idempotencyKey: `${SEED_KEY_PREFIX}-${keyIndex}`,
  });
  if (!r.ok) throw new Error(`seed append failed: ${r.error.code}`);
};

/**
 * The canonical compact world: `sealedBatches` full segments (sealed at cap)
 * plus an open tail — head.lastSeq = sealedBatches*SEGMENT_ENTRY_CAP + tail.
 * Every envelope is MissionRenamed (payload missionId = missionIdForSeq(seq)).
 */
export const seedCompactWorld = async (
  engine: StorageEnginePort,
  opts: { sealedBatches?: number; tail?: number; deviceId?: DeviceId } = {},
): Promise<{ headSeq: number }> => {
  const sealedBatches = opts.sealedBatches ?? CANONICAL_SEALED_BATCHES;
  const tail = opts.tail ?? WORLD_TAIL_ENTRIES;
  const deviceId = opts.deviceId ?? DEV_A;
  const journal = createJournal(engine);
  let seq = 1;
  for (let b = 0; b < sealedBatches; b += 1) {
    const batch = Array.from({ length: SEGMENT_ENTRY_CAP }, (_, i) =>
      makeEnv(seq + i, seq + i, deviceId),
    );
    await appendBatch(journal, batch, b);
    seq += SEGMENT_ENTRY_CAP;
  }
  const tailBatch = Array.from({ length: tail }, (_, i) => makeEnv(seq + i, seq + i, deviceId));
  await appendBatch(journal, tailBatch, sealedBatches);
  return { headSeq: seq + tail - 1 };
};

/**
 * Full-exclusion world: EVERY entry of the first sealed segment references
 * `trashId`; the rest is the canonical world (2 more sealed + tail).
 */
export const seedTrashSegmentWorld = async (
  engine: StorageEnginePort,
  trashId: string,
): Promise<{ headSeq: number }> => {
  const journal = createJournal(engine);
  const trashBatch = Array.from({ length: SEGMENT_ENTRY_CAP }, (_, i) =>
    makeTrashEnv(i + 1, i + 1, trashId),
  );
  await appendBatch(journal, trashBatch, 0);
  let seq = SEGMENT_ENTRY_CAP + 1;
  for (let b = 1; b < TRASH_WORLD_SEALED_BATCHES; b += 1) {
    const batch = Array.from({ length: SEGMENT_ENTRY_CAP }, (_, i) =>
      makeEnv(seq + i, seq + i, DEV_A),
    );
    await appendBatch(journal, batch, b);
    seq += SEGMENT_ENTRY_CAP;
  }
  const tail = Array.from({ length: WORLD_TAIL_ENTRIES }, (_, i) =>
    makeEnv(seq + i, seq + i, DEV_A),
  );
  await appendBatch(journal, tail, TRASH_WORLD_SEALED_BATCHES);
  return { headSeq: seq + WORLD_TAIL_ENTRIES - 1 };
};

// ---------------------------------------------------------------------------
// Plan factories.
// ---------------------------------------------------------------------------

const PURGED_AT_BASE_MS = 1_786_000_000_000;

export const chainFor = (id: string, epoch = 1, kind = 'Mission'): PurgeChainRef => ({
  kind,
  id,
  purgedAt: PURGED_AT_BASE_MS,
  purgeEpoch: epoch,
});

export const makePlan = (over: Partial<CompactionPlan> = {}): CompactionPlan => ({
  deviceId: DEV_A,
  throughSeq: 1000,
  purgeChains: [chainFor(missionIdForSeq(PLAN_TARGET_SEQ_DEFAULT))],
  ...over,
});

// ---------------------------------------------------------------------------
// Durable-truth snapshots (byte-identity law probes).
// ---------------------------------------------------------------------------

type MetaRow = { key: string; value: unknown };

/** FULL durable image (events + every meta row) canonicalized — twin worlds
 *  and resume paths must agree byte for byte, idempotency ledger included. */
export const snapWorld = async (engine: StorageEnginePort): Promise<string> => {
  const r = await engine.txn(['events', 'meta'], 'readonly', async (tx) => {
    const events = await tx.table<JournalSegmentRecord>('events').toArray();
    const meta = await tx.table<MetaRow>('meta').toArray();
    return stableStringify({ events, meta });
  });
  if (!r.ok) throw new Error(`snap failed: ${r.error.code}`);
  return r.value;
};

export const readSegments = async (
  engine: StorageEnginePort,
): Promise<readonly JournalSegmentRecord[]> => {
  const r = await engine.txn(['events'], 'readonly', (tx) =>
    tx.table<JournalSegmentRecord>('events').toArray(),
  );
  if (!r.ok) throw new Error(`segments read failed: ${r.error.code}`);
  return r.value;
};

export const readBaseline = async (
  engine: StorageEnginePort,
  deviceId: DeviceId = DEV_A,
): Promise<CompactionBaseline | null> => {
  const r = await engine.txn(['meta'], 'readonly', async (tx) => {
    const row = await tx.table<MetaRow>('meta').get(META_PURGE_EPOCH_KEY);
    const table = (row?.value ?? {}) as Record<string, CompactionBaseline>;
    return table[deviceId as string] ?? null;
  });
  if (!r.ok) throw new Error(`baseline read failed: ${r.error.code}`);
  return r.value;
};

// ---------------------------------------------------------------------------
// Torn-state builders — replicate the compactor's chunk txn EXACTLY, through
// the SAME exported policy fns (fixtures must never bend production code).
// ---------------------------------------------------------------------------

const chunkSizeOf = (plan: CompactionPlan): number =>
  plan.chunkSegments !== undefined && plan.chunkSegments >= 1
    ? plan.chunkSegments
    : CHUNK_SEGMENTS_DEFAULT;

/**
 * Apply the first `chunksToApply` chunks of `plan`'s window and leave the
 * running baseline the uninterrupted run would have written. chunksToApply
 * may equal the chunk count (all applied, status left running — the
 * baseline-flip.before kill image).
 */
export const applyCompactChunks = async (
  engine: StorageEnginePort,
  plan: CompactionPlan,
  chunksToApply: number,
): Promise<void> => {
  const segments = await readSegments(engine);
  const chunks = chunkWindow(
    windowSegments(segments, plan.deviceId as string, plan.throughSeq),
    chunkSizeOf(plan),
  );
  const prev = await readBaseline(engine, plan.deviceId);
  const epoch = (prev?.epoch ?? 0) + 1;
  const planDigest = digestOfPlan(plan);
  let excludedTotal = 0;
  let excludedFold = EMPTY_EXCLUDED_DIGEST;
  for (let ci = 0; ci < Math.min(chunksToApply, chunks.length); ci += 1) {
    const chunk = chunks[ci] ?? [];
    const cursorForTxn: number | null = chunks[ci + 1]?.at(0)?.seqStart ?? null;
    const r = await engine.txn(['events', 'meta'], 'readwrite', async (tx) => {
      const events = tx.table<JournalSegmentRecord>('events');
      const meta = tx.table<MetaRow>('meta');
      const baseRow = await meta.get(META_PURGE_EPOCH_KEY);
      const table = { ...((baseRow?.value ?? {}) as Record<string, CompactionBaseline>) };
      for (const segment of chunk) {
        const { kept, excluded } = excludeEntries(
          segment.entries,
          plan.throughSeq,
          plan.purgeChains,
        );
        if (excluded.length === 0) continue;
        if (kept.length === 0) {
          await events.delete(segment.segmentId);
        } else {
          await events.put(withFreshCrc({ ...segment, entries: kept }));
        }
        excludedTotal += excluded.length;
        excludedFold = foldExcludedInto(
          excludedFold,
          excluded.map((m) => m.eventId),
        );
      }
      // Mirror of the production row law: the baseline lands ONLY once a
      // first exclusion exists (a 0-exclusion row is not a production state).
      if (excludedTotal > 0) {
        table[plan.deviceId as string] = {
          schemaV: 1,
          deviceId: plan.deviceId,
          status: 'running',
          epoch,
          throughSeq: plan.throughSeq,
          planDigest,
          cursorSeqStart: cursorForTxn,
          entriesExcluded: excludedTotal,
          excludedDigest: excludedFold,
        };
        await meta.put({ key: META_PURGE_EPOCH_KEY, value: table });
      }
      return undefined;
    });
    if (!r.ok) throw new Error(`torn chunk failed: ${r.error.code}`);
  }
};

/** compact.checkpoint.mid image: all chunks + the flip, restamp never ran. */
export const applyCompactThroughFlip = async (
  engine: StorageEnginePort,
  plan: CompactionPlan,
): Promise<void> => {
  const segments = await readSegments(engine);
  const chunks = chunkWindow(
    windowSegments(segments, plan.deviceId as string, plan.throughSeq),
    chunkSizeOf(plan),
  );
  await applyCompactChunks(engine, plan, chunks.length);
  const r = await engine.txn(['meta'], 'readwrite', async (tx) => {
    const meta = tx.table<MetaRow>('meta');
    const baseRow = await meta.get(META_PURGE_EPOCH_KEY);
    const table = { ...((baseRow?.value ?? {}) as Record<string, CompactionBaseline>) };
    const running = table[plan.deviceId as string];
    if (running === undefined) throw new Error('flip fixture: no running baseline');
    table[plan.deviceId as string] = { ...running, status: 'done' };
    await meta.put({ key: META_PURGE_EPOCH_KEY, value: table });
    return undefined;
  });
  if (!r.ok) throw new Error(`torn flip failed: ${r.error.code}`);
};

// ---------------------------------------------------------------------------
// Txn accounting wrapper (L7 chunk-honor probe: exactly one events-mutating
// txn per chunk — the kill-point matrix depends on that boundary being real).
// ---------------------------------------------------------------------------

export interface TxnAccounting {
  /** readwrite txns that performed ≥1 write on the events table (chunk txns). */
  readonly eventsMutatingTxns: () => number;
  /** Total events-table writes (put+delete) observed. */
  readonly eventsWrites: () => number;
}

export const withTxnCount = (
  engine: StorageEnginePort,
): { engine: StorageEnginePort; accounting: TxnAccounting } => {
  let mutatingTxns = 0;
  let writes = 0;
  const wrapped: StorageEnginePort = {
    ...engine,
    txn: <T>(
      scope: readonly StoreName[],
      mode: TxnMode,
      work: (tx: TxScope) => Promise<T>,
    ): Promise<Result<T, LedgeError>> =>
      engine.txn<T>(scope, mode, (tx) => {
        let wroteHere = false;
        const counting: TxScope = {
          table: <R extends StoredRecord>(name: StoreName): StoreHandle<R> => {
            const handle = tx.table<R>(name);
            if (name !== 'events' || mode !== 'readwrite') return handle;
            return {
              ...handle,
              put: async (record: R): Promise<void> => {
                wroteHere = true;
                writes += 1;
                await handle.put(record);
              },
              putMany: async (records: readonly R[]): Promise<void> => {
                wroteHere = true;
                writes += records.length;
                await handle.putMany(records);
              },
              delete: async (key: Parameters<StoreHandle<R>['delete']>[0]): Promise<void> => {
                wroteHere = true;
                writes += 1;
                await handle.delete(key);
              },
              deleteMany: async (
                keys: Parameters<StoreHandle<R>['deleteMany']>[0],
              ): Promise<void> => {
                wroteHere = true;
                writes += keys.length;
                await handle.deleteMany(keys);
              },
            };
          },
        };
        return work(counting).then((value) => {
          if (wroteHere) mutatingTxns += 1;
          return value;
        });
      }),
  };
  return {
    engine: wrapped,
    accounting: { eventsMutatingTxns: () => mutatingTxns, eventsWrites: () => writes },
  };
};

export { DEV_A, DEV_B };
