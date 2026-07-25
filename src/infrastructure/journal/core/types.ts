// E1-T10 · journal persistence shapes (events store, EES §5 row 1) + meta anchors.
// The on-disk entry mirrors StoredEvent ({v, event}) with journal ordering stamps —
// hlc/type/payload per EES §5 live inside the frozen envelope. formatV stamps the
// SEGMENT format (v1; EES §2.8 versioning), distinct from per-event schema v.
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';

export const JOURNAL_FORMAT_V = 1;

/**
 * Segment sizing: entries are packed into one open segment per device stream until the
 * cap, then the segment is sealed and a new one opens. A batch always lands in exactly
 * one segment (batch-atomic), so a batch larger than the cap is a caller bug.
 * 500 entries/segment bounds structured-clone cost per segment write and keeps the
 * E2-T01 CRC walk's per-segment work small; ~1M events/yr worst case ⇒ ~2k segments/yr.
 */
export const SEGMENT_ENTRY_CAP = 500;

/** One stored event row inside a segment (EES §5: {seq, batchIndex, hlc, type, payload}). */
export type JournalEntryRecord = {
  readonly seq: number;
  readonly batchIndex: number;
  /** StoredEvent format version of `event` (per-event schema version; upcast on read). */
  readonly v: number;
  readonly event: EventEnvelope;
};

export type JournalSegmentRecord = {
  /** Deterministic: `${deviceId}:${seqStart}` — unique per (device, segment start). */
  readonly segmentId: string;
  readonly deviceId: DeviceId;
  readonly seqStart: number;
  readonly sealed: boolean;
  readonly formatV: number;
  readonly entries: JournalEntryRecord[];
  /**
   * CRC-32 hex over the canonical image of every field above (segment.ts owns the
   * projection). Recomputed on open-segment writes, frozen at seal — after which any
   * bit drift is provably detectable (ADR-004 accident model).
   */
  readonly crc: string;
};

/** Per-device stream anchor in meta (single-writer, so write contention is impossible). */
export type DeviceStreamHead = {
  readonly lastSeq: number;
  readonly lastLamport: number;
  readonly openSegmentId: string | null;
};

export const META_JOURNAL_HEADS_KEY = 'journalHeads';
export const META_IDEMPOTENCY_PREFIX = 'journal.idem.';

/**
 * meta row name for checkpoint pointers, per EES §5's meta-row inventory. Value is a
 * Record<deviceId, CheckpointStamp-shaped row> (§2.8: checkpoints restorable with zero
 * replay; §2.8 versioning: baselines live in meta, never in the segments themselves).
 */
export const META_CHECKPOINT_KEY = 'checkpointPtrs';

export const idempotencyMetaKey = (batchKey: string): string =>
  `${META_IDEMPOTENCY_PREFIX}${batchKey}`;

/**
 * Ledger row for the 250ms retry law (EES §2.8). batchHash (FNV-1a over the ordered
 * eventIds) makes key reuse with DIFFERENT content a hard integrity violation — silently
 * replaying an ack over alien content would be a data-loss mask for caller bugs.
 */
export type IdempotencyRecord = {
  readonly ack: {
    readonly deviceId: string;
    readonly fromSeq: number;
    readonly toSeq: number;
    readonly count: number;
  };
  readonly batchHash: string;
};
