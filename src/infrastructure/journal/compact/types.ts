// E2-T11 · journal compaction + purge exclusion (ADR-004 "physical segment
// collapse honoring purge law"; ADR-020 "journal compaction that physically
// rewrites segments excluding purged events"; EES §2.8 invariant "compaction
// performs physical exclusion of purged bytes"; EES §5 global law 4 "purges
// are physical rewrites at journal level"; Blueprint §14.3 epochs;
// roadmap R-02 "epoch design"; EES §4 TrashPurged "compaction must physically
// exclude; purgeEpoch recorded in meta").
//
// THE SEVEN LAWS THIS MODULE ENCODES (and its suites prove):
//   L1 HORIZON — throughSeq < head.lastSeq; the open tail is never in window.
//   L2 EXCLUSION — within [≤ throughSeq], entries whose payload references a
//      committed purge chain are physically dropped; every other entry
//      survives byte-identical (seq/batchIndex/v/event untouched).
//   L3 PHYSICALITY — a fully-excluded segment row is DELETED (bytes gone,
//      not masked); survivors carry fresh CRCs over their new content.
//   L4 TAIL — entries/segments beyond the horizon keep their exact bytes.
//   L5 EPOCH — meta.purgeEpoch per device: monotonic, status running|done,
//      planDigest-bound (resume = same plan only; a running row names the
//      in-flight window so the scanner law tolerates purge gaps at/≤ horizon).
//   L6 BASELINE-AWARE SCAN — with a baseline, gaps at/≤ throughSeq are lawful;
//      strict +1 chaining is reasserted above it (E2-T01 scanner comment:
//      "compaction baselines arrive with E2-T11").
//   L7 KILL-SAFETY — chunked: each segment batch lands atomically in ONE txn;
//      every inter-chunk state is scan-lawful; re-running compact() resumes
//      to the byte-identical end state (idempotent exclusion).
//
// Kill classes this design survives (chaos suite proves): kill mid-rewrite,
// kill after last rewrite before the status flip, kill before the checkpoint
// restamp. The open segment is never rewritten — sealed-byte mutation is the
// ONE lawful exception to "sealed immutable", epoch-tagged and baseline-gated
// (see docs/adr-notes/ADR-020b-T11-sealed-exclusion-window.md).
import type { CheckpointStamp } from '@/application/ports/journal.port.js';
import type { DeviceId } from '@/shared-kernel/identity/index.js';

/** EES §4 TrashPurged row shape (sweeper → compaction feed). */
export type PurgeChainRef = {
  readonly kind: string;
  readonly id: string;
  readonly purgedAt: number;
  readonly purgeEpoch: number;
};

/** What the caller asks for: one exclusion sweep over one device stream. */
export type CompactionPlan = {
  readonly deviceId: DeviceId;
  /** Exclusion horizon: entries with seq ≤ throughSeq are purge-eligible. */
  readonly throughSeq: number;
  readonly purgeChains: readonly PurgeChainRef[];
  /** Segments per chunk transaction (default in compactor.ts; ≥1). */
  readonly chunkSegments?: number | undefined;
};

/** One excluded entry (audit trail — "disclose precisely"; sampled + digested). */
export type ExcludedMatch = {
  readonly seq: number;
  readonly batchIndex: number;
  readonly eventId: string;
  readonly chainKind: string;
  readonly chainId: string;
};

/** EES §5 meta inventory row `purgeEpoch` (storage shape lives in core/types
 *  beside META_PURGE_EPOCH_KEY; re-exported here, the module's public face). */
export type { CompactionBaseline } from '../core/types.js';

export type CompactionReport = {
  readonly schemaV: 1;
  readonly deviceId: string;
  readonly epoch: number;
  readonly planDigest: string;
  /** A running baseline was found and continued (same plan). */
  readonly resumed: boolean;
  /** Nothing eligible happened (empty window / zero matches / same-plan replay). */
  readonly noOp: boolean;
  readonly throughSeq: number;
  readonly segmentsInWindow: number;
  readonly segmentsRewritten: number;
  /** Fully-excluded segment rows physically deleted (L3). */
  readonly segmentsDeleted: number;
  readonly entriesExcluded: number;
  /** Capped audit sample (counts + digest carry the whole story). */
  readonly excludedSample: readonly ExcludedMatch[];
  readonly excludedDigest: string;
  /** Checkpoint stamps restamped over the compacted bytes (L7 close-out). */
  readonly checkpoints: readonly CheckpointStamp[];
};
