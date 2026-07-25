// E2-T11 · the compactor — resumable chunked physical rewrite (the L1..L7
// engine behind JournalPort.compact; see compact/types.ts for the law table).
//
// Execution shape (every inter-point kill-safe):
//   plan → window → for each chunk (ONE txn):
//       per segment: exclusion projection → put fresh-CRC survivors /
//       DELETE fully-excluded rows (L3) → upsert the running baseline
//       (seq-anchored cursor) once the first exclusion lands
//   → final txn flips the baseline done (L5) → checkpoint restamp (L7 close).
//
// Resume (L5/L7): a done-baseline carrying the same planDigest ⇒ no-op replay
// (idempotence); a running one with the same digest ⇒ continue at its cursor;
// a running one with a DIFFERENT digest ⇒ two compaction plans raced — a
// caller bug prosecuted as E_JOURNAL_INTEGRITY, never silently merged.
//
// The cursor is SEQ-ANCHORED (baseline.cursorSeqStart): fully-excluded window
// segments are DELETED mid-sweep, so any index-anchored progress cursor would
// shift under a kill; segment seqStart is format-frozen at append and immune
// to deletion. Resume = re-window + skip everything below the cursor, which
// is exact because per-segment exclusion is idempotent — and the end state is
// BYTE-IDENTICAL to an uninterrupted run (cursor-independent totals: counts
// partition, the xor-fold digest commutes), chaos-proven at all three kill
// points (compact.segment-rewrite.mid / .baseline-flip.before / .checkpoint.mid).
import type { CheckpointStamp } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { withFreshCrc } from '../core/segment.js';
import {
  META_JOURNAL_HEADS_KEY,
  META_PURGE_EPOCH_KEY,
  type CompactionBaseline,
  type DeviceStreamHead,
  type JournalSegmentRecord,
} from '../core/types.js';
import {
  CHUNK_SEGMENTS_DEFAULT,
  EMPTY_EXCLUDED_DIGEST,
  EXCLUDED_SAMPLE_CAP,
  chunkWindow,
  digestOfPlan,
  excludeEntries,
  foldExcludedInto,
  windowSegments,
} from './policy.js';
import type { CompactionPlan, CompactionReport, ExcludedMatch } from './types.js';

type MetaRow = { key: string; value: unknown };
type BaselineTable = Record<string, CompactionBaseline>;

const compactError = (raw: string, extra?: Record<string, string | number | boolean | null>) =>
  ledgeError('E_JOURNAL_INTEGRITY', { raw, ...extra });

export interface CompactorDeps {
  readonly engine: StorageEnginePort;
  /** Reuse the scanner's restamp so the checkpoint law has exactly one home. */
  readonly checkpoint: () => Promise<Result<{ stamped: readonly CheckpointStamp[] }, LedgeError>>;
}

interface JournalReadState {
  readonly segments: readonly JournalSegmentRecord[];
  readonly baselines: BaselineTable;
  readonly heads: Record<string, DeviceStreamHead>;
}

const readState = async (
  engine: StorageEnginePort,
): Promise<Result<JournalReadState, LedgeError>> =>
  engine.txn(['events', 'meta'], 'readonly', async (tx) => {
    const segments = await tx.table<JournalSegmentRecord>('events').toArray();
    const baseRow = await tx.table<MetaRow>('meta').get(META_PURGE_EPOCH_KEY);
    const headRow = await tx.table<MetaRow>('meta').get(META_JOURNAL_HEADS_KEY);
    return {
      segments,
      baselines: (baseRow?.value ?? {}) as BaselineTable,
      heads: (headRow?.value ?? {}) as Record<string, DeviceStreamHead>,
    };
  });

export const compactJournal = async (
  deps: CompactorDeps,
  plan: CompactionPlan,
): Promise<Result<CompactionReport, LedgeError>> => {
  const state = await readState(deps.engine);
  if (!state.ok) return state;
  const { segments, baselines, heads } = state.value;
  const deviceKey = plan.deviceId as string;
  const head = heads[deviceKey];

  // L1 horizon law: the sweep window closes strictly below the device head —
  // the open tail is never eligible, so nothing here can starve the live edge.
  if (head === undefined || plan.throughSeq >= head.lastSeq) {
    return err(compactError('compaction-horizon-invalid', { throughSeq: plan.throughSeq }));
  }
  if (plan.purgeChains.length === 0) {
    return err(compactError('compaction-plan-empty'));
  }
  const planDigest = digestOfPlan(plan);
  const chunkSize =
    plan.chunkSegments !== undefined && plan.chunkSegments >= 1
      ? plan.chunkSegments
      : CHUNK_SEGMENTS_DEFAULT;

  const prev = baselines[deviceKey];
  if (prev !== undefined && prev.schemaV !== 1) {
    return err(compactError('compaction-baseline-unknown'));
  }

  const window = windowSegments(segments, deviceKey, plan.throughSeq);
  const chunks = chunkWindow(window, chunkSize);

  // L5 epoch idempotence: same plan already DONE ⇒ replay is a true no-op.
  const doneSamePlan =
    prev !== undefined && prev.status === 'done' && prev.planDigest === planDigest;
  if (doneSamePlan) {
    const stamped = await deps.checkpoint();
    if (!stamped.ok) return stamped;
    return ok({
      schemaV: 1,
      deviceId: deviceKey,
      epoch: prev.epoch,
      planDigest,
      resumed: false,
      noOp: true,
      throughSeq: plan.throughSeq,
      segmentsInWindow: window.length,
      segmentsRewritten: 0,
      segmentsDeleted: 0,
      entriesExcluded: prev.entriesExcluded,
      excludedSample: [],
      excludedDigest: prev.excludedDigest,
      checkpoints: stamped.value.stamped,
    });
  }
  if (prev !== undefined && prev.status === 'running' && prev.planDigest !== planDigest) {
    return err(compactError('compaction-plan-conflict', { digest: prev.planDigest }));
  }
  // Horizon monotonicity law: a NEW sweep may only push the eligibility
  // horizon forward. A regression would move earlier epochs' purge gaps
  // outside THIS baseline's tolerance window (scanner law L6 tolerates gaps
  // only at/≤ the current baseline's horizon) — unsound by construction, so
  // the plan is refused instead of silently re-baselined. (Blueprint §14.3
  // epochs are monotonic; the horizon rides the same law.)
  if (prev !== undefined && plan.throughSeq < prev.throughSeq) {
    return err(
      compactError('compaction-horizon-regression', {
        throughSeq: plan.throughSeq,
        baselineThroughSeq: prev.throughSeq,
      }),
    );
  }
  const resumed = prev !== undefined && prev.status === 'running' && prev.planDigest === planDigest;

  const epoch =
    prev?.epoch !== undefined && prev.status === 'running' ? prev.epoch : (prev?.epoch ?? 0) + 1;
  // Skip boundary: resume skips every window segment below the recorded
  // cursor (a null cursor on a running row = the window was already
  // exhausted — only the flip/checkpoint remained when the kill landed).
  const skipBelow = resumed ? (prev.cursorSeqStart ?? Number.MAX_SAFE_INTEGER) : -1;

  let excludedTotal = resumed ? prev.entriesExcluded : 0;
  // Resume-safe accumulation: the xor-fold continues from the running row; the
  // fresh-match list feeds this run's audit sample + the fold.
  let excludedFold = resumed ? prev.excludedDigest : EMPTY_EXCLUDED_DIGEST;
  const excludedMatches: ExcludedMatch[] = [];
  let segmentsRewritten = 0;
  let segmentsDeleted = 0;
  let anyExclusion = resumed && prev.entriesExcluded > 0;

  for (let ci = 0; ci < chunks.length; ci += 1) {
    const chunk = (chunks[ci] ?? []).filter((segment) => segment.seqStart >= skipBelow);
    if (chunk.length > 0) {
      const chunkTx = await deps.engine.txn(['events', 'meta'], 'readwrite', async (tx) => {
        const events = tx.table<JournalSegmentRecord>('events');
        const meta = tx.table<MetaRow>('meta');
        const baseRow = await meta.get(META_PURGE_EPOCH_KEY);
        const table: BaselineTable = { ...((baseRow?.value ?? {}) as BaselineTable) };
        for (const segment of chunk) {
          const { kept, excluded } = excludeEntries(
            segment.entries,
            plan.throughSeq,
            plan.purgeChains,
          );
          if (excluded.length === 0) continue; // untouched bytes stay byte-exact (L4 discipline)
          anyExclusion = true;
          if (kept.length === 0) {
            await events.delete(segment.segmentId);
            segmentsDeleted += 1;
          } else {
            await events.put(withFreshCrc({ ...segment, entries: kept }));
            segmentsRewritten += 1;
          }
          excludedTotal += excluded.length;
          excludedMatches.push(...excluded);
          excludedFold = foldExcludedInto(
            excludedFold,
            excluded.map((m) => m.eventId),
          );
        }
        // Running baseline — L5/L6: the in-flight window becomes lawful to
        // scans. Written ONLY once a first exclusion has landed: a sweep that
        // excludes nothing must leave no durable trace (a stale running row
        // would falsely prosecute the next plan as a conflict).
        if (anyExclusion) {
          table[deviceKey] = {
            schemaV: 1,
            deviceId: plan.deviceId,
            status: 'running',
            epoch,
            throughSeq: plan.throughSeq,
            planDigest,
            cursorSeqStart: chunks[ci + 1]?.at(0)?.seqStart ?? null,
            entriesExcluded: excludedTotal,
            excludedDigest: excludedFold,
          };
          await meta.put({ key: META_PURGE_EPOCH_KEY, value: table });
        }
        return undefined;
      });
      if (!chunkTx.ok) return chunkTx;
    }
  }

  // No bytes were ever eligible: nothing excluded ⇒ no baseline needed (scan
  // laws stay dense; L5 says a baseline exists only to explain purge gaps).
  // The no-op is BYTE-TRUE: a sweep that excluded nothing writes nothing —
  // no baseline, no checkpoint (the durability watermark moves only when
  // bytes did). A pre-existing 0-exclusion running row is unreachable via
  // production writes (rows land with ≥1 exclusion); erasing it is lossless
  // — it certifies no gap — and the closing restamp then completes that
  // repair's convergence, exactly as in the exclusion path's close-out.
  if (!anyExclusion) {
    let stampedRows: readonly CheckpointStamp[] = [];
    if (prev !== undefined && prev.status === 'running') {
      const dropTx = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
        const meta = tx.table<MetaRow>('meta');
        const baseRow = await meta.get(META_PURGE_EPOCH_KEY);
        const table: BaselineTable = { ...((baseRow?.value ?? {}) as BaselineTable) };
        const kept: BaselineTable = {};
        for (const [key, value] of Object.entries(table)) {
          if (key !== deviceKey) kept[key] = value;
        }
        await meta.put({ key: META_PURGE_EPOCH_KEY, value: kept });
        return undefined;
      });
      if (!dropTx.ok) return dropTx;
      const stamped = await deps.checkpoint();
      if (!stamped.ok) return stamped;
      stampedRows = stamped.value.stamped;
    }
    return ok({
      schemaV: 1,
      deviceId: deviceKey,
      epoch: prev?.epoch ?? 0,
      planDigest,
      resumed,
      noOp: true,
      throughSeq: plan.throughSeq,
      segmentsInWindow: window.length,
      segmentsRewritten: 0,
      segmentsDeleted: 0,
      entriesExcluded: 0,
      excludedSample: [],
      excludedDigest: EMPTY_EXCLUDED_DIGEST,
      checkpoints: stampedRows,
    });
  }

  // Final flip (own txn: the flip-after-last-chunk boundary is a kill point).
  const flipTx = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
    const meta = tx.table<MetaRow>('meta');
    const baseRow = await meta.get(META_PURGE_EPOCH_KEY);
    const table: BaselineTable = { ...((baseRow?.value ?? {}) as BaselineTable) };
    const running = table[deviceKey];
    if (
      running === undefined ||
      running.status !== 'running' ||
      running.planDigest !== planDigest
    ) {
      throw compactError('compaction-flip-lost-baseline', { digest: planDigest });
    }
    table[deviceKey] = { ...running, status: 'done' };
    await meta.put({ key: META_PURGE_EPOCH_KEY, value: table });
    return undefined;
  });
  if (!flipTx.ok) return flipTx;

  const stamped = await deps.checkpoint();
  if (!stamped.ok) return stamped;

  return ok({
    schemaV: 1,
    deviceId: deviceKey,
    epoch,
    planDigest,
    resumed,
    noOp: false,
    throughSeq: plan.throughSeq,
    segmentsInWindow: window.length,
    segmentsRewritten,
    segmentsDeleted,
    entriesExcluded: excludedTotal,
    excludedSample: excludedMatches.slice(0, EXCLUDED_SAMPLE_CAP),
    excludedDigest: excludedFold,
    checkpoints: stamped.value.stamped,
  });
};
