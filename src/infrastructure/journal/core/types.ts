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
 * meta row name for per-device compaction baselines — the EES §5 meta-row
 * inventory names this key `purgeEpoch` (EES §4 TrashPurged: "purgeEpoch
 * recorded in meta"). The record value (Record<deviceId, CompactionBaseline>)
 * anchors the L5/L6 laws of E2-T11: epoch monotonicity + baseline-aware scans.
 */
export const META_PURGE_EPOCH_KEY = 'purgeEpoch';

/**
 * E2-T11 compaction baseline (storage shape — lives beside its meta key).
 * running ⇒ a chunked sweep is in flight (the scanner tolerates purge gaps
 * at/≤ throughSeq); done ⇒ closed out. planDigest binds resume to one plan.
 *
 * The progress cursor is SEQ-ANCHORED, never index-anchored: a window segment
 * that loses every entry is physically DELETED mid-sweep, which shifts window
 * positions under any index cursor — a seqStart anchor is invariant under
 * deletion (segment seqStart is format-frozen at append), so resume simply
 * skips segments whose seqStart lies below the cursor.
 */
export type CompactionBaseline = {
  readonly schemaV: 1;
  readonly deviceId: DeviceId;
  readonly status: 'running' | 'done';
  /** Monotonic per device (EES §4/§5 purgeEpoch semantics). */
  readonly epoch: number;
  /** Exclusion horizon: entries with seq ≤ throughSeq were purge-eligible.
   *  Monotone non-decreasing per device across epochs — a regression would make
   *  earlier epochs' gaps fall outside the baseline's tolerance window. */
  readonly throughSeq: number;
  /** fnv1a64 over the canonical plan — resume is lawful for THIS plan only. */
  readonly planDigest: string;
  /** Resume boundary: seqStart of the first UNPROCESSED window segment;
   *  null ⇒ the window is exhausted (only the status flip/checkpoint remain). */
  readonly cursorSeqStart: number | null;
  readonly entriesExcluded: number;
  /** XOR-fold of per-id fnv1a64 hashes (commutative ⇒ resume-safe). */
  readonly excludedDigest: string;
};

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
