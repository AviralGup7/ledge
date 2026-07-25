// E2-T11 chaos — compaction kill-point matrix. Every compact.* point in
// ops/chaos/points.txt is a durability boundary of the chunked sweep
// (ADR-004 collapse law + ADR-020 physical purge; EES §8 chaos discipline).
// Fixtures build the torn durable image through the SAME policy fns the
// production sweep uses (never bent production code), assert the in-flight
// image is scan-lawful (L6 running baselines), then resume and prove the
// L7 law: byte-identical end state vs the uninterrupted twin.
import { describe, expect, it } from 'vitest';
import type { CompactionPlan } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { CompactionReport } from '@/application/ports/journal.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, openEngine } from '../core/testkit.js';
import {
  COMPACT_KILL_POINTS,
  applyCompactChunks,
  applyCompactThroughFlip,
  chainFor,
  missionIdForSeq,
  seedCompactWorld,
  snapWorld,
} from './testkit.js';

const unwrap = <T>(r: Result<T, LedgeError>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
  return r.value;
};

// Canonical chaos plan: two exclusions, one per window segment, so each chunk
// boundary is a meaningful kill door. chunkSegments=1 ⇒ 2 chunk txns.
const CHAIN_ONE_SEQ = 7;
const CHAIN_TWO_SEQ = 600;
const EXCLUDED_TOTAL = 2;

const chaosPlan = (): CompactionPlan => ({
  deviceId: DEV_A,
  throughSeq: 750,
  chunkSegments: 1,
  purgeChains: [chainFor(missionIdForSeq(CHAIN_ONE_SEQ)), chainFor(missionIdForSeq(CHAIN_TWO_SEQ))],
});

const CHUNK_COUNT = 2;

/** Tear world A, boot the journal over it, resume, and race against twin B. */
const tornVsTwin = async (
  plan: CompactionPlan,
  applyTorn: (engine: StorageEnginePort, plan: CompactionPlan) => Promise<void>,
): Promise<{ report: CompactionReport; tornScanOk: boolean; byteEqual: boolean }> => {
  const engineA = await openEngine();
  await seedCompactWorld(engineA);
  await applyTorn(engineA, plan);
  const journalA = createJournal(engineA);
  const tornScanOk = unwrap(await journalA.scanFull(), 'scan@torn').status === 'ok';
  const report = unwrap(await journalA.compact(plan), 'resume');

  const engineB = await openEngine();
  await seedCompactWorld(engineB);
  unwrap(await createJournal(engineB).compact(plan), 'twin');
  const byteEqual = (await snapWorld(engineA)) === (await snapWorld(engineB));
  await engineA.close();
  await engineB.close();
  return { report, tornScanOk, byteEqual };
};

describe('E2-T11 chaos — kill-point constitution (compact slice)', () => {
  it('this suite owns exactly the compact.* points of points.txt, disjoint by prefix', () => {
    expect([...COMPACT_KILL_POINTS].sort()).toEqual(
      [
        'compact.baseline-flip.before',
        'compact.checkpoint.mid',
        'compact.segment-rewrite.mid',
      ].sort(),
    );
    for (const point of COMPACT_KILL_POINTS) expect(point.startsWith('compact.')).toBe(true);
    // The exact three-way partition (file == reconciler ∪ marker ∪ compact,
    // disjoint) is constitution-asserted in the marker suite + the harness.
  });
});

describe('E2-T11 chaos — compact.segment-rewrite.mid (kill mid-window)', () => {
  it('running baseline at a mid cursor: torn image scan-lawful, resume byte-equal', async () => {
    const plan = chaosPlan();
    const { report, tornScanOk, byteEqual } = await tornVsTwin(
      plan,
      (engine, p) => applyCompactChunks(engine, p, 1), // chunk 0 of 2 committed; the SW died
    );
    expect(tornScanOk).toBe(true); // L6: the running baseline explains the gap
    expect(report.resumed).toBe(true);
    expect(report.noOp).toBe(false);
    expect(report.entriesExcluded).toBe(EXCLUDED_TOTAL); // carried + fresh
    expect(byteEqual).toBe(true); // L7: the law, byte for byte
  });
});

describe('E2-T11 chaos — compact.baseline-flip.before (kill at the flip door)', () => {
  it('window exhausted, status never flipped: resume flips and byte-equals', async () => {
    const plan = chaosPlan();
    const { report, tornScanOk, byteEqual } = await tornVsTwin(
      plan,
      (engine, p) => applyCompactChunks(engine, p, CHUNK_COUNT), // all chunks; flip never ran
    );
    expect(tornScanOk).toBe(true);
    expect(report.resumed).toBe(true);
    expect(report.noOp).toBe(false);
    expect(report.segmentsRewritten).toBe(0); // nothing fresh: it all landed pre-kill
    expect(report.entriesExcluded).toBe(EXCLUDED_TOTAL);
    expect(byteEqual).toBe(true);
  });
});

describe('E2-T11 chaos — compact.checkpoint.mid (kill before the restamp)', () => {
  it('baseline done, checkpoint stale: replay restamps and byte-equals', async () => {
    const plan = chaosPlan();
    const { report, tornScanOk, byteEqual } = await tornVsTwin(plan, applyCompactThroughFlip);
    expect(tornScanOk).toBe(true); // done baseline still explains the gaps
    expect(report.resumed).toBe(false); // a done baseline replays, never "resumes"
    expect(report.noOp).toBe(true);
    expect(report.entriesExcluded).toBe(EXCLUDED_TOTAL); // epoch totals carried
    const stamp = report.checkpoints.find((c) => (c.deviceId as string) === (DEV_A as string));
    expect(stamp).toBeDefined(); // the restamp the kill suppressed
    expect(byteEqual).toBe(true);
  });
});
