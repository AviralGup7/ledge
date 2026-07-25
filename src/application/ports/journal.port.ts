// E1-T10 · EES §2.8/§6 JournalPort — the durable write seam of the truth engine (ADR-004).
// Internal sub-port of the storage family: implemented by infrastructure/journal, called by
// the authority (application hub) and read by projections/recovery. Writer concentration
// (ADR-005) is structural: only application, roots, and the journal/storage/recovery/
// projections family may import infrastructure/journal at all (depcruise enforced).
//
// Laws encoded here (EES §2.8):
//  * ack ⇒ durable: append resolves only after the IDB transaction commits.
//  * acked events appear in readRange monotonically — (seq, batchIndex) per device stream
//    (EES §4 ordering law).
//  * ack timeout 250ms is the CALLER's deadline (hub timing discipline); on timeout the
//    caller retries with the SAME batch idempotency key, and the journal must not
//    double-append — hence the key is mandatory, not optional.
//  * upcast on read: payloads are frozen at write (§2.4); readRange returns envelopes run
//    through the kernel upcast chain, with forward-tolerance passthrough (ADR-033).
//  * CRC/segments integrity, scanTail/scanFull, compact, checkpoint land in E2-T01/E2-T11 —
//    this core carries append + readRange only (roadmap E1-T10 scope).
import type { Hlc } from '@/shared-kernel/clock/index.js';
import type { EventEnvelope, StoredEvent } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { StoreName, TxScope } from './storage-engine.port.js';

/** Ack of one applied batch (EES §2.8 "Outputs: append ack {seq}"). */
export interface AppendAck {
  readonly deviceId: DeviceId;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
}

export interface JournalRangeQuery {
  readonly deviceId: DeviceId;
  /** Inclusive lower bound (seq ≥ fromSeq). */
  readonly fromSeq: number;
  /** Inclusive upper bound; omitted → up to the device head. */
  readonly toSeq?: number | undefined;
}

/** One journal entry after upcast-on-read: envelope + its journal ordering stamps. */
export interface JournalReadEvent {
  readonly seq: number;
  readonly batchIndex: number;
  readonly envelope: EventEnvelope;
}

/** ADR-033 forward-tolerance row: a stored event this build cannot upcast. Replay keeps
 *  it (never dropped); projectors skip it. */
export interface PreservedUnknown {
  readonly seq: number;
  readonly batchIndex: number;
  readonly stored: StoredEvent;
  readonly reason: 'type' | 'version';
}

export interface ReadRangeResult {
  readonly events: readonly JournalReadEvent[];
  readonly preservedUnknown: readonly PreservedUnknown[];
  /** Highest contiguous acked seq for this device stream (0 when nothing appended). */
  readonly durableThrough: number;
}

/**
 * Why a segment failed verification (E2-T01 integrity walks). E_JOURNAL_INTEGRITY's
 * details.segmentId points at the FIRST suspect; scan reports enumerate them all.
 */
export type SegmentSuspectReason =
  | 'crc-mismatch'
  | 'format-unknown'
  | 'chain-sequence'
  | 'seal-law'
  | 'head-drift'
  | 'lamport-regression'
  | 'entry-gap'
  | 'boundary-drift';

export interface SegmentSuspect {
  readonly segmentId: string;
  readonly reason: SegmentSuspectReason;
  readonly expectedCrc?: string | undefined;
  readonly actualCrc?: string | undefined;
}

export interface DeviceScanSummary {
  readonly deviceId: DeviceId;
  readonly segments: number;
  readonly entries: number;
  readonly durableThrough: number;
}

/**
 * Integrity walk outcome (§2.8 "Outputs: integrity reports"). status 'suspect' means
 * prosecution-quality evidence of byte drift — recovery (E2-T06) owns the repair policy;
 * the journal's job is precise disclosure, never silent truncation of user truth.
 */
export interface JournalIntegrityReport {
  readonly status: 'ok' | 'suspect';
  /** 'tail' = post-checkpoint region only (WAL-design, ≤50ms law); 'full' = every byte. */
  readonly coverage: 'tail' | 'full';
  readonly suspects: readonly SegmentSuspect[];
  readonly devices: readonly DeviceScanSummary[];
}

/** One device's checkpoint pointer stamped into meta.checkpointPtrs (§5/§2.8). */
export interface CheckpointStamp {
  readonly deviceId: DeviceId;
  readonly throughSeq: number;
  readonly lastSegmentId: string;
  /** CRC of the segment containing throughSeq at stamp time (audit baseline). */
  readonly crc: string;
}

export interface CheckpointResult {
  readonly stamped: readonly CheckpointStamp[];
}

export interface JournalPort {
  /**
   * Append one contiguous batch (all envelopes same deviceId, hlc.seq strictly
   * consecutive from the device head, lamport non-decreasing per EES §2.2).
   * Idempotent by idempotencyKey: a retry with a seen key replays the recorded ack
   * without writing. Integrity violations → E_JOURNAL_INTEGRITY (never partial writes:
   * batch, segment update, and head/index rows commit in one transaction).
   */
  append(
    batch: readonly EventEnvelope[],
    opts: { readonly idempotencyKey: string },
  ): Promise<Result<AppendAck, LedgeError>>;
  /**
   * EES §5 law 2 — the durability hinge: append the batch and run `hinge` writes in the
   * SAME IDB transaction (the intent ledger's acceptance/completion rows ride this).
   * The whole write-class shares one fate: hinge throw ⇒ batch never commits; idem-key
   * replay ⇒ hinge never re-runs (both committed together the first time or not at all).
   */
  appendHinged(
    batch: readonly EventEnvelope[],
    opts: {
      readonly idempotencyKey: string;
      readonly extraStores?: readonly StoreName[] | undefined;
      readonly hinge?: ((tx: TxScope) => Promise<void>) | undefined;
    },
  ): Promise<Result<AppendAck, LedgeError>>;
  /**
   * Read the device stream in (seq, batchIndex) order, upcasting per entry (§2.8
   * versioning law). Post-law: every acked event appears monotonically. A segment whose
   * CRC no longer verifies inside the range is never served: E_JOURNAL_INTEGRITY with
   * details.segmentId (corrupt bytes are not the truth; recovery owns repair).
   */
  readRange(query: JournalRangeQuery): Promise<Result<ReadRangeResult, LedgeError>>;
  /**
   * Cheap steady-state integrity walk: verifies only the post-checkpoint region per
   * device (open segment + anything appended since the latest checkpoint stamp).
   * Without any checkpoint it degrades to a full walk of the empty-history boundary —
   * which is the full journal. Steady-state budget ≤50ms (E2-T01 completion law).
   */
  scanTail(): Promise<Result<JournalIntegrityReport, LedgeError>>;
  /** CRC-walk every segment of every device stream plus chain/seal/head/lamport laws. */
  scanFull(): Promise<Result<JournalIntegrityReport, LedgeError>>;
  /**
   * Stamp meta.checkpointPtrs for every device (EES §5 checkpointPtrs; §2.8 invariant:
   * checkpoint ⇒ restorable to that point with zero replay). Stamping over suspect
   * bytes would lie about restorability, so a suspect journal → E_JOURNAL_INTEGRITY
   * (details.segmentId = first suspect) and nothing is written. Idempotent.
   */
  checkpoint(): Promise<Result<CheckpointResult, LedgeError>>;
}

export type { DeviceId, EventEnvelope, Hlc, StoredEvent };
