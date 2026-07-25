// E1-T10 · journal appender core (EES §2.8, ADR-004) — append + readRange.
//
// Durability hinge (EES §5 law 1/2): one batch = one IDB transaction spanning events+meta;
// the ack resolves only after commit. Three write-classes land atomically per batch:
// the segment record, the per-device stream head, and the idempotency ledger row.
//
// Write path is STRICT (hub emits registered types only; an unknown type is a producer
// bug — v2's RemoteEventsApplied carry preserve-append for future-version remote events,
// which is a deliberate v2 seam, not a v1 gap). Read path is TOLERANT (§2.4/ADR-033):
// upcast-on-read, forward versions/types pass through preserved, never dropped.
import type {
  AppendAck,
  JournalPort,
  JournalReadEvent,
  JournalRangeQuery,
  PreservedUnknown,
  ReadRangeResult,
} from '@/application/ports/journal.port.js';
import type {
  StorageEnginePort,
  StoreHandle,
  StoreName,
  TxScope,
} from '@/application/ports/storage-engine.port.js';
import { isHlc } from '@/shared-kernel/clock/index.js';
import { upcastEvent, validateEnvelope, validatePayload } from '@/shared-kernel/events/index.js';
import type { EventEnvelope, StoredEvent } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { fnv1a64 } from '@/shared-kernel/canon/index.js';
import {
  batchFits,
  needsRollover,
  newSegment,
  seal,
  verifySegmentCrc,
  withBatchAppended,
} from './segment.js';
import {
  META_JOURNAL_HEADS_KEY,
  SEGMENT_ENTRY_CAP,
  idempotencyMetaKey,
  type DeviceStreamHead,
  type IdempotencyRecord,
  type JournalSegmentRecord,
} from './types.js';

/** meta row wrapper: §5 meta is key → value. */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

const SEGMENT_ORDER_INDEX = '[deviceId+seqStart]';

const integrityError = (raw: string, extra?: Record<string, string | number | boolean | null>) =>
  ledgeError('E_JOURNAL_INTEGRITY', { raw, ...extra });

const isSafeSeq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** Batch-level preflight that needs no DB state. Returns the stream's deviceId. */
function preflightBatch(
  batch: readonly EventEnvelope[],
): Result<{ deviceId: DeviceId; firstSeq: number; firstLamport: number }, LedgeError> {
  if (batch.length === 0) return err(integrityError('empty-batch'));
  if (!batchFits(batch.length)) {
    return err(integrityError('oversized-batch', { size: batch.length, cap: SEGMENT_ENTRY_CAP }));
  }
  const first = batch.at(0);
  if (first === undefined) return err(integrityError('empty-batch'));
  const validFirst = validateEnvelope(first);
  if (!validFirst.ok) return validFirst;
  if (!isHlc(first.hlc)) return err(integrityError('hlc-malformed'));
  const deviceId = first.hlc.deviceId;
  let prev: EventEnvelope | undefined;
  let at = 0;
  for (const e of batch) {
    const v = validateEnvelope(e);
    if (!v.ok) return v;
    if (e.hlc.deviceId !== deviceId) return err(integrityError('cross-device-batch'));
    if (!isSafeSeq(e.hlc.seq)) return err(integrityError('seq-unsafe'));
    if (!isSafeSeq(e.hlc.lamport)) return err(integrityError('lamport-unsafe'));
    // Strict write: payloads must satisfy the registered schema (EES §4 registry law).
    const p = validatePayload(e.type, e.payload);
    if (!p.ok) return p;
    if (prev !== undefined) {
      if (e.hlc.seq !== prev.hlc.seq + 1) {
        return err(
          integrityError('seq-not-contiguous', { at, prev: prev.hlc.seq, got: e.hlc.seq }),
        );
      }
      // EES §2.2: lamport never decreases within a device journal.
      if (e.hlc.lamport < prev.hlc.lamport) {
        return err(
          integrityError('lamport-regression', {
            at,
            prev: prev.hlc.lamport,
            got: e.hlc.lamport,
          }),
        );
      }
    }
    prev = e;
    at += 1;
  }
  return ok({ deviceId, firstSeq: first.hlc.seq, firstLamport: first.hlc.lamport });
}

export function createJournalAppender(
  engine: StorageEnginePort,
): Pick<JournalPort, 'append' | 'appendHinged' | 'readRange'> {
  const runAppend = async (
    batch: readonly EventEnvelope[],
    opts: {
      readonly idempotencyKey: string;
      readonly extraStores?: readonly StoreName[] | undefined;
      readonly hinge?: ((tx: TxScope) => Promise<void>) | undefined;
    },
  ): Promise<Result<AppendAck, LedgeError>> => {
    const pre = preflightBatch(batch);
    if (!pre.ok) return pre;
    const { deviceId, firstSeq, firstLamport } = pre.value;
    if (opts.idempotencyKey.trim().length === 0) {
      return err(integrityError('idempotency-key-empty'));
    }

    // §5 law 2: one txn spans every store the write-class touches (hinge stores ride
    // along; a hinge throw aborts the segment/head/idempotency writes with it).
    const scope: StoreName[] = [
      ...new Set<StoreName>(['events', 'meta', ...(opts.extraStores ?? [])]),
    ];
    return engine.txn(scope, 'readwrite', async (tx) => {
      const events = tx.table<JournalSegmentRecord>('events');
      const meta = tx.table<MetaRow>('meta');

      // (2.8 retry law) seen idempotency key ⇒ replay the recorded ack, write nothing —
      // but only for byte-identical content (key+alien content is a hard violation).
      const batchHash = fnv1a64(JSON.stringify(batch.map((e) => e.eventId)));
      const idemRow = await meta.get(idempotencyMetaKey(opts.idempotencyKey));
      if (idemRow !== undefined) {
        const record = idemRow.value as IdempotencyRecord;
        if (record.batchHash !== batchHash) {
          throw integrityError('idempotency-key-reuse', { key: opts.idempotencyKey });
        }
        return record.ack as AppendAck;
      }

      const headsRow = await meta.get(META_JOURNAL_HEADS_KEY);
      const heads = (headsRow?.value ?? {}) as Record<string, DeviceStreamHead>;
      const head: DeviceStreamHead = heads[deviceId as string] ?? {
        lastSeq: 0,
        lastLamport: 0,
        openSegmentId: null,
      };

      // Contiguity with the durable stream (EES §2.2 seq monotonic per device).
      if (firstSeq !== head.lastSeq + 1) {
        throw integrityError('seq-gap-vs-head', { expected: head.lastSeq + 1, got: firstSeq });
      }
      if (firstLamport < head.lastLamport) {
        throw integrityError('lamport-regression-vs-head', {
          head: head.lastLamport,
          got: firstLamport,
        });
      }

      // Open segment: from the head anchor. Drift cases are integrity violations —
      // the CRC verdict comes FIRST (drifted bytes may not even be interpreted),
      // then the anchor seal law.
      let open: JournalSegmentRecord | null = null;
      if (head.openSegmentId !== null) {
        const rec = await events.get(head.openSegmentId);
        if (rec === undefined)
          throw integrityError('head-segment-missing', { segmentId: head.openSegmentId });
        const crcVerdict = verifySegmentCrc(rec);
        if (!crcVerdict.ok) {
          throw integrityError('segment-crc-mismatch', {
            segmentId: rec.segmentId,
            expectedCrc: crcVerdict.expected,
            actualCrc: crcVerdict.actual,
          });
        }
        if (rec.sealed)
          throw integrityError('head-segment-sealed', { segmentId: head.openSegmentId });
        open = rec;
      }

      // Segment rollover (sealed segments immutable: we only ever write the open one,
      // and seal-once flips exactly one flag exactly once).
      let target = open;
      if (open !== null && needsRollover(open, batch.length)) {
        await events.put(seal(open));
        target = null;
      }
      if (target === null) target = newSegment(deviceId, firstSeq);
      await events.put(withBatchAppended(target, batch));

      const last = batch.at(-1);
      if (last === undefined) throw integrityError('empty-batch'); // preflight guaranteed
      const ack: AppendAck = {
        deviceId,
        fromSeq: firstSeq,
        toSeq: last.hlc.seq,
        count: batch.length,
      };
      heads[deviceId as string] = {
        lastSeq: last.hlc.seq,
        lastLamport: last.hlc.lamport,
        openSegmentId: target.sealed ? null : target.segmentId,
      };
      await meta.put({ key: META_JOURNAL_HEADS_KEY, value: heads });
      await meta.put({
        key: idempotencyMetaKey(opts.idempotencyKey),
        value: { ack, batchHash } satisfies IdempotencyRecord,
      });
      // Hinge rides LAST: journal invariants are settled before caller writes, and
      // its throw aborts everything above (one commit, one fate — EES §5 law 2).
      if (opts.hinge !== undefined) await opts.hinge(tx);
      return ack;
    });
  };

  return {
    append: (batch, opts) => runAppend(batch, opts),

    appendHinged: (batch, opts) => runAppend(batch, opts),

    async readRange(query: JournalRangeQuery): Promise<Result<ReadRangeResult, LedgeError>> {
      if (!isSafeSeq(query.fromSeq)) return err(integrityError('range-fromSeq-invalid'));
      if (query.toSeq !== undefined && (!isSafeSeq(query.toSeq) || query.toSeq < query.fromSeq)) {
        return err(integrityError('range-toSeq-invalid'));
      }
      return engine.txn(['events', 'meta'], 'readonly', async (tx) => {
        const events = tx.table<JournalSegmentRecord>('events');
        const meta = tx.table<MetaRow>('meta');

        const headsRow = await meta.get(META_JOURNAL_HEADS_KEY);
        const heads = (headsRow?.value ?? {}) as Record<string, DeviceStreamHead>;
        const head = heads[query.deviceId as string];
        const durableThrough = head?.lastSeq ?? 0;

        // Segments partition the device stream and sit under the compound order index —
        // index-covered fan-in, no scan path (EES §2.9 law).
        const segments = await byIndexAll(events, query.deviceId);
        // Horizon clamp: readRange exposes the ACKED stream only. A toSeq beyond
        // durableThrough must not leak torn-tail entries (§2.8 ack ⇔ visible equivalence).
        const toSeq = Math.min(query.toSeq ?? Number.MAX_SAFE_INTEGER, durableThrough);
        const within = segments.filter((s) => {
          const tailSeq = s.entries.at(-1)?.seq;
          return (
            s.entries.length > 0 &&
            s.seqStart <= toSeq &&
            tailSeq !== undefined &&
            tailSeq >= query.fromSeq
          );
        });

        const out: JournalReadEvent[] = [];
        const preserved: PreservedUnknown[] = [];
        for (const segment of within) {
          // Never serve bytes the CRC can't vouch for (EES §2.8 integrity failure).
          const crcVerdict = verifySegmentCrc(segment);
          if (!crcVerdict.ok) {
            throw integrityError('segment-crc-mismatch', {
              segmentId: segment.segmentId,
              expectedCrc: crcVerdict.expected,
              actualCrc: crcVerdict.actual,
            });
          }
          for (const entry of segment.entries) {
            if (entry.seq < query.fromSeq || entry.seq > toSeq) continue;
            const upcasted = readUpcast({ v: entry.v, event: entry.event });
            if (!upcasted.ok) throw upcasted.error;
            if (upcasted.value.status === 'preserved-unknown') {
              preserved.push({
                seq: entry.seq,
                batchIndex: entry.batchIndex,
                stored: upcasted.value.raw,
                reason: upcasted.value.reason,
              });
            } else {
              out.push({
                seq: entry.seq,
                batchIndex: entry.batchIndex,
                envelope: upcasted.value.event,
              });
            }
          }
        }
        // §4 ordering law: (seq, batchIndex) per device stream — sorted defensively so the
        // postcondition "acked events appear in readRange monotonically" is composition-
        // independent (segments already partition in order; the sort is the law's home).
        out.sort((a, b) => a.seq - b.seq || a.batchIndex - b.batchIndex);
        preserved.sort((a, b) => a.seq - b.seq || a.batchIndex - b.batchIndex);
        return { events: out, preservedUnknown: preserved, durableThrough };
      });
    },
  };
}

/** Read-path seam into the kernel (§2.8 upcast-on-read); E2-T01 adds the suspect-segment
 *  short-circuit here, keeping corruption policy in exactly one place. */
const readUpcast = (stored: StoredEvent) => upcastEvent(stored);

const byIndexAll = (
  events: StoreHandle<JournalSegmentRecord>,
  deviceId: DeviceId,
): Promise<readonly JournalSegmentRecord[]> =>
  events.byIndex({
    kind: 'between',
    name: SEGMENT_ORDER_INDEX,
    lower: [deviceId as string, Number.NEGATIVE_INFINITY],
    upper: [deviceId as string, Number.POSITIVE_INFINITY],
  });
