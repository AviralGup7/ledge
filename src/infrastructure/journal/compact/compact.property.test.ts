// E2-T11 property suite — compaction laws over generated worlds + plans.
//   P1 PURGED BYTES ABSENT (roadmap R-02 criterion): after compact, no
//      horizon-eligible payload referencing a purged id survives — at the
//      STORE level and in the served stream.
//   P2 SURVIVOR IDENTITY: the post-compaction stream equals the pre stream
//      filtered by the exclusion predicate, byte for byte.
//   P3 SCAN LAWS: scanFull is ok over compacted bytes; checkpoint succeeds;
//      a 0-exclusion sweep leaves the world byte-frozen (true no-op).
//   P4 KILL-RESUME EQUIVALENCE: kill after ANY chunk boundary, resume with
//      the same plan ⇒ byte-identical durable truth vs the uninterrupted twin.
//   P5 SAME-PLAN REPLAY: a done sweep replays as a byte-frozen no-op.
//   P6 LIVE-EDGE CONTINUITY: appends after compaction continue contiguously
//      and the grown journal passes every scan law.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, makeEnv, openEngine } from '../core/testkit.js';
import { chunkWindow, payloadMatchesId, windowSegments } from './policy.js';
import {
  applyCompactChunks,
  chainFor,
  makePlan,
  missionIdForSeq,
  readSegments,
  seedCompactWorld,
  snapWorld,
} from './testkit.js';

const unwrap = <T>(r: Result<T, LedgeError>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
  return r.value;
};

/** Generated I/O suites (journal seeds + compactions × FC_NUM_RUNS) need real headroom. */
const PROP_TIMEOUT_MS = 600_000;
const FALLBACK_RUNS = 500;
/** Lane wall-clock law: each run seeds ≥517 events across 2-3 engines through
 *  real transactions — unbounded at nightly's 10k this suite would burst the
 *  per-test timeout without proportionate evidence, so it caps at 2000
 *  (≥2× the PR lane's 1k; completeness here rides on shrinking, not volume). */
const COMPACT_PROP_RUN_CAP = 2000;

const laneRuns = (): number => {
  const configured = fc.readConfigureGlobal().numRuns;
  const global = typeof configured === 'number' && configured > 0 ? configured : FALLBACK_RUNS;
  return Math.min(global, COMPACT_PROP_RUN_CAP);
};

interface WorldSpec {
  readonly sealedBatches: number;
  readonly tail: number;
}

interface PlanSpec {
  readonly throughSeq: number;
  readonly chainSeqs: readonly number[];
  readonly chunkSegments: number;
}

const worldArb: fc.Arbitrary<WorldSpec> = fc.record({
  sealedBatches: fc.integer({ min: 1, max: 2 }),
  tail: fc.integer({ min: 1, max: 25 }),
});

const planArb = (head: number): fc.Arbitrary<PlanSpec> =>
  fc.record({
    throughSeq: fc.integer({ min: 1, max: head - 1 }),
    // Targets both present seqs and seqs just past the head (absent ids).
    chainSeqs: fc.array(fc.integer({ min: 1, max: head + 10 }), { minLength: 1, maxLength: 6 }),
    chunkSegments: fc.integer({ min: 1, max: 3 }),
  });

const planOf = (spec: PlanSpec) =>
  makePlan({
    throughSeq: spec.throughSeq,
    chunkSegments: spec.chunkSegments,
    purgeChains: [...new Set(spec.chainSeqs)].map((seq) => chainFor(missionIdForSeq(seq))),
  });

const seed = async (world: WorldSpec): Promise<StorageEnginePort> => {
  const engine = await openEngine();
  await seedCompactWorld(engine, world);
  return engine;
};

const headOf = (world: WorldSpec): number => world.sealedBatches * 500 + world.tail;

/** Every entry the sweep is LAWFULLY allowed to drop for this plan (pre-state).
 *  Jurisdiction law (L1/L4 + ADR-020b): sealed segments only — an entry in the
 *  OPEN tail is never eligible, even at/below the horizon. The last full batch
 *  of a world seals only when the tail batch rolls it over, so generated
 *  throughSeq values can lawfully land inside the open tail. */
const matchedSeqs = async (
  engine: StorageEnginePort,
  throughSeq: number,
  chainIds: readonly string[],
): Promise<Set<number>> => {
  const out = new Set<number>();
  for (const segment of await readSegments(engine)) {
    if (!segment.sealed) continue;
    for (const entry of segment.entries) {
      if (entry.seq > throughSeq) continue;
      if (chainIds.some((id) => payloadMatchesId(entry.event.payload, id))) out.add(entry.seq);
    }
  }
  return out;
};

describe('E2-T11 property — P1/P2/P3 sweep laws over generated worlds + plans', () => {
  it(
    'compact ⇒ purged bytes absent (store+served), survivors identical, scans ok, 0-exclusion frozen',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          worldArb.chain((w) => planArb(headOf(w)).map((p) => ({ w, p }))),
          async ({ w, p }) => {
            const engine = await seed(w);
            try {
              const journal = createJournal(engine);
              const plan = planOf(p);
              const chainIds = plan.purgeChains.map((c) => c.id);
              const matched = await matchedSeqs(engine, plan.throughSeq, chainIds);
              const preRange = unwrap(
                await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }),
                'pre',
              );
              const frozenBefore = matched.size === 0 ? await snapWorld(engine) : null;

              const report = unwrap(await journal.compact(plan), 'compact');
              expect(report.entriesExcluded).toBe(matched.size);
              expect(report.noOp).toBe(matched.size === 0);

              // P1a — store-level byte absence: no horizon-eligible reference
              // survives IN THE SWEEP'S JURISDICTION (sealed segments; the open
              // tail is immutable by law, so a purged-id reference there is not
              // an exclusion violation — see the matchedSeqs law note).
              for (const segment of await readSegments(engine)) {
                if (!segment.sealed) continue;
                for (const entry of segment.entries) {
                  const stillMatched =
                    entry.seq <= plan.throughSeq &&
                    chainIds.some((id) => payloadMatchesId(entry.event.payload, id));
                  expect(stillMatched).toBe(false);
                }
              }
              // P1b/P2 — served stream: pre filtered by the exclusion predicate, exactly.
              const postRange = unwrap(
                await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }),
                'post',
              );
              const expected = preRange.events.filter((e) => !matched.has(e.seq));
              expect(stableStringify(postRange.events)).toBe(stableStringify(expected));

              // P3 — scan laws hold over compacted bytes. The frozen check must
              // precede THIS test's own checkpoint probe: compact's no-op is
              // byte-true, but an explicit checkpoint() lawfully stamps the ptr.
              expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
              if (matched.size === 0) {
                // True no-op: no baseline, and the world is byte-frozen.
                expect(unwrap(await journal.compactionState(DEV_A), 'state')).toBeNull();
                expect(await snapWorld(engine)).toBe(frozenBefore);
              } else {
                const baseline = unwrap(await journal.compactionState(DEV_A), 'state');
                expect(baseline?.status).toBe('done');
                expect(baseline?.entriesExcluded).toBe(matched.size);
              }
              unwrap(await journal.checkpoint(), 'checkpoint');
            } finally {
              await engine.close();
            }
          },
        ),
        { numRuns: laneRuns() },
      );
    },
    PROP_TIMEOUT_MS,
  );
});

describe('E2-T11 property — P4 kill/resume byte-equivalence at every chunk boundary', () => {
  it(
    'kill after any chunk boundary ⇒ resume converges to the uninterrupted twin, byte for byte',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          worldArb.chain((w) =>
            planArb(headOf(w)).chain((p) =>
              fc.integer({ min: 1, max: 4 }).map((killAfter) => ({ w, p, killAfter })),
            ),
          ),
          async ({ w, p, killAfter }) => {
            const plan = planOf(p);
            // World A: torn (killed after min(killAfter, chunks) chunk txns).
            const engineA = await seed(w);
            // World B: uninterrupted twin (seeded on the same arb values).
            const engineB = await seed(w);
            try {
              const segmentsA = await readSegments(engineA);
              const chunks = chunkWindow(
                windowSegments(segmentsA, DEV_A as string, plan.throughSeq),
                plan.chunkSegments ?? 1,
              );
              await applyCompactChunks(engineA, plan, Math.min(killAfter, chunks.length));
              // L6 at the kill image: whatever prefix landed is scan-lawful.
              expect(unwrap(await createJournal(engineA).scanFull(), 'scan@torn').status).toBe(
                'ok',
              );
              const reportA = unwrap(await createJournal(engineA).compact(plan), 'resume');
              const reportB = unwrap(await createJournal(engineB).compact(plan), 'twin');
              expect(await snapWorld(engineA)).toBe(await snapWorld(engineB));
              expect(reportA.entriesExcluded).toBe(reportB.entriesExcluded);
              expect(reportA.excludedDigest).toBe(reportB.excludedDigest);
            } finally {
              await engineA.close();
              await engineB.close();
            }
          },
        ),
        { numRuns: laneRuns() },
      );
    },
    PROP_TIMEOUT_MS,
  );
});

describe('E2-T11 property — P5 replay idempotence + P6 live-edge continuity', () => {
  it(
    'same-plan replay is byte-frozen; appended growth after compaction passes every scan law',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          worldArb.chain((w) => planArb(headOf(w)).map((p) => ({ w, p }))),
          async ({ w, p }) => {
            const engine = await seed(w);
            const journal: JournalPort = createJournal(engine);
            try {
              const plan = planOf(p);
              const first = unwrap(await journal.compact(plan), 'first');
              const frozen = await snapWorld(engine);
              const second = unwrap(await journal.compact(plan), 'replay');
              if (first.noOp) {
                expect(second.noOp).toBe(true);
              } else {
                expect(second.noOp).toBe(true);
                expect(second.entriesExcluded).toBe(first.entriesExcluded);
              }
              expect(await snapWorld(engine)).toBe(frozen);

              // P6 — the live edge continues: new appends chain densely at
              // head.lastSeq+1 and every scan law still holds over grown bytes.
              const head = headOf(w);
              const tailBatch = Array.from({ length: 5 }, (_, i) =>
                makeEnv(head + i + 1, head + i + 1),
              );
              unwrap(await journal.append(tailBatch, { idempotencyKey: 'prop-grow' }), 'grow');
              const tail = unwrap(
                await journal.readRange({ deviceId: DEV_A, fromSeq: head + 1 }),
                'tail read',
              );
              expect(tail.events.map((e) => e.seq)).toEqual([
                head + 1,
                head + 2,
                head + 3,
                head + 4,
                head + 5,
              ]);
              expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
              expect(unwrap(await journal.scanTail(), 'scanTail').status).toBe('ok');
            } finally {
              await engine.close();
            }
          },
        ),
        { numRuns: laneRuns() },
      );
    },
    PROP_TIMEOUT_MS,
  );
});
