// E2-T10 · property-suites capstone (roadmap row: "Replay invariants,
// purge-law byte-absence (EES §8)"; deliverable home ops/tests/property;
// completion criteria: "1k seeds CI green; purge bytes absent"). The G1 exit
// row names exactly these two properties — this suite pins them at the gate,
// cross-engine, on top of the per-module suites (E2-T01..T04, E2-T11).
//
//   A. PURGE-LAW BYTE-ABSENCE (R-02 criterion, gate mirror) — generated
//      journals + purge plans ⇒ after compact(): (store) no eligible entry
//      referencing a purged id survives in sealed bytes; (served) readRange
//      never replays one; (twins) the compacted durable image is byte-equal
//      across engines (journal-level snapshot equivalence); scans/checkpoint
//      and the done-baseline close out lawfully.
//   B. REPLAY INVARIANTS — same journal ⇒ identical models across engines
//      (projection determinism); watermarks ride the true applied head;
//      disposable rebuild ≡ live apply (snapshot equivalence); published
//      deltas alone reconstruct the stores (§3.5 faithfulness).
//
// Volume note (lane wall-clock law): section A worlds are IO-bound (≥517-event
// seeds, twin engines) — at nightly's 10k the unbounded run count would burst
// the per-test timeout without adding proportionate evidence, so A caps at
// COMPACT_GATE_RUN_CAP (≥4× the PR lane's 1k). Section B is cheap and rides
// the lane's full volume.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CompactionReport } from '@/application/ports/journal.port.js';
import type { ViewDeltaFrame } from '@/application/ports/projection-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { payloadMatchesId } from '@/infrastructure/journal/compact/index.js';
import {
  chainFor,
  makePlan,
  missionIdForSeq,
  readBaseline,
  readSegments,
  seedCompactWorld,
  snapWorld,
} from '@/infrastructure/journal/compact/testkit.js';
import { DEV_A, openEngine } from '@/infrastructure/journal/core/testkit.js';
import {
  assignedEnv,
  closedEnv,
  formedEnv,
  makeProjections,
  renamedEnv,
  seedJournal,
  storeSnapshot,
  type ProjectionHarness,
} from '@/infrastructure/projections/testkit.js';

const unwrap = <T>(r: Result<T, LedgeError>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
  return r.value;
};

const PROP_TIMEOUT_MS = 600_000;
/** Section-A run cap (see the volume note in this file's header). */
const COMPACT_GATE_RUN_CAP = 2000;
const FALLBACK_RUNS = 500;

const laneRuns = (cap: number): number => {
  const configured = fc.readConfigureGlobal().numRuns;
  const global = typeof configured === 'number' && configured > 0 ? configured : FALLBACK_RUNS;
  return Math.min(global, cap);
};

// ---------------------------------------------------------------------------
// A · purge-law byte-absence (gate mirror of roadmap R-02 / E2-T10 criterion).
// ---------------------------------------------------------------------------

interface PurgeSpec {
  readonly sealedBatches: number;
  readonly tail: number;
  readonly throughSeq: number;
  readonly chainSeqs: readonly number[];
  readonly chunkSegments: number;
}

const purgeSpecArb: fc.Arbitrary<PurgeSpec> = fc
  .record({ sealedBatches: fc.integer({ min: 1, max: 2 }), tail: fc.integer({ min: 1, max: 25 }) })
  .chain((w) => {
    const head = w.sealedBatches * 500 + w.tail;
    return fc.record({
      sealedBatches: fc.constant(w.sealedBatches),
      tail: fc.constant(w.tail),
      throughSeq: fc.integer({ min: 1, max: head - 1 }),
      chainSeqs: fc.array(fc.integer({ min: 1, max: head + 10 }), { minLength: 1, maxLength: 6 }),
      chunkSegments: fc.integer({ min: 1, max: 3 }),
    });
  });

const runPurge = async (
  spec: PurgeSpec,
): Promise<{ engine: Awaited<ReturnType<typeof openEngine>>; report: CompactionReport }> => {
  const engine = await openEngine();
  await seedCompactWorld(engine, { sealedBatches: spec.sealedBatches, tail: spec.tail });
  const plan = makePlan({
    throughSeq: spec.throughSeq,
    chunkSegments: spec.chunkSegments,
    purgeChains: [...new Set(spec.chainSeqs)].map((seq) => chainFor(missionIdForSeq(seq))),
  });
  const journal = createJournal(engine);
  const report = unwrap(await journal.compact(plan), 'compact');
  return { engine, report };
};

describe('E2-T10 property — purge law: bytes absent (store, served, twin-equal)', () => {
  it(
    'compact ⇒ no eligible reference survives; identical image across engines; scans lawful',
    { timeout: PROP_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(purgeSpecArb, async (spec) => {
          const plan = makePlan({
            throughSeq: spec.throughSeq,
            chunkSegments: spec.chunkSegments,
            purgeChains: [...new Set(spec.chainSeqs)].map((seq) => chainFor(missionIdForSeq(seq))),
          });
          const chainIds = plan.purgeChains.map((c) => c.id);

          // Model of the lawful exclusion set (sealed jurisdiction, ≤ horizon).
          const probe = await openEngine();
          await seedCompactWorld(probe, {
            sealedBatches: spec.sealedBatches,
            tail: spec.tail,
          });
          const matched = new Set<number>();
          for (const segment of await readSegments(probe)) {
            if (!segment.sealed) continue;
            for (const entry of segment.entries) {
              if (
                entry.seq <= spec.throughSeq &&
                chainIds.some((id) => payloadMatchesId(entry.event.payload, id))
              ) {
                matched.add(entry.seq);
              }
            }
          }
          await probe.close();

          const a = await runPurge(spec);
          const b = await runPurge(spec);
          try {
            expect(a.report.entriesExcluded).toBe(matched.size);
            // STORE: no eligible survivor in sealed bytes (bytes physically gone).
            for (const segment of await readSegments(a.engine)) {
              if (!segment.sealed) continue;
              for (const entry of segment.entries) {
                const survivor =
                  entry.seq <= spec.throughSeq &&
                  chainIds.some((id) => payloadMatchesId(entry.event.payload, id));
                expect(survivor).toBe(false);
              }
            }
            // SERVED: replay never surfaces a purged entry.
            const journalA = createJournal(a.engine);
            const served = unwrap(
              await journalA.readRange({ deviceId: DEV_A, fromSeq: 0 }),
              'readRange',
            );
            expect(served.events.some((e) => matched.has(e.seq))).toBe(false);
            // TWIN: the compacted durable image is engine-independent (byte-equal).
            expect(await snapWorld(a.engine)).toBe(await snapWorld(b.engine));
            expect(a.report.excludedDigest).toBe(b.report.excludedDigest);
            // Close-out laws hold over purged bytes.
            expect(unwrap(await journalA.scanFull(), 'scanFull').status).toBe('ok');
            unwrap(await journalA.checkpoint(), 'checkpoint');
            if (matched.size > 0) {
              const baseline = await readBaseline(a.engine);
              expect(baseline?.status).toBe('done');
              expect(baseline?.entriesExcluded).toBe(matched.size);
            } else {
              expect(a.report.noOp).toBe(true);
              expect(await readBaseline(a.engine)).toBeNull();
            }
          } finally {
            await a.engine.close();
            await b.engine.close();
          }
        }),
        { numRuns: laneRuns(COMPACT_GATE_RUN_CAP) },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// B · replay invariants (determinism · watermark · snapshot equivalence).
// ---------------------------------------------------------------------------

type Op =
  | { readonly kind: 'formed'; readonly m: number; readonly tabs: readonly number[] }
  | { readonly kind: 'renamed'; readonly m: number }
  | { readonly kind: 'assigned'; readonly t: number; readonly m: number }
  | { readonly kind: 'closed'; readonly t: number; readonly m: number };

const opArb: fc.Arbitrary<Op> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 6 }))
  .chain(([m, t]) =>
    fc.oneof(
      fc.subarray([1, 2, 3, 4, 5, 6]).map((tabs) => ({ kind: 'formed', m, tabs }) as const),
      fc.constant({ kind: 'renamed', m } as const),
      fc.constant({ kind: 'assigned', t, m } as const),
      fc.constant({ kind: 'closed', t, m } as const),
    ),
  );

const streamOf = (ops: readonly Op[]): EventEnvelope[] =>
  ops.map((op, i) => {
    const seq = i + 1;
    switch (op.kind) {
      case 'formed':
        return formedEnv(seq, op.m, op.tabs);
      case 'renamed':
        return renamedEnv(seq, op.m, `name-${seq}`);
      case 'assigned':
        return assignedEnv(seq, op.t, op.m);
      case 'closed':
        return closedEnv(seq, op.t, op.m);
    }
  });

/** Canon comparator shared by the store shelves AND the delta-replay shelves:
 *  faithfulness compares CONTENT, and `storeSnapshot` returns pk order while
 *  the frame replay has no pk notion — both sides canonize identically. */
const shelfCanon = <T>(rows: readonly T[]): readonly T[] =>
  [...rows].sort((x, y) => (stableStringify(x) < stableStringify(y) ? -1 : 1));

const snapshotAll = async (h: ProjectionHarness): Promise<string> =>
  stableStringify({
    missions: shelfCanon(await storeSnapshot(h, 'missions')),
    recently_closed: shelfCanon(await storeSnapshot(h, 'recently_closed')),
    sessions: shelfCanon(await storeSnapshot(h, 'sessions')),
    tabs: shelfCanon(await storeSnapshot(h, 'tabs')),
  });

/** §3.5 faithfulness harness: replay the published deltas onto empty shelves.
 *  REGRESSION LOCK (fc-seed-−1953314806-class): this mirror MUST stay ViewName-TOTAL —
 *  when the registry grew the 'tabs' view (E3-APP), the 3-view mirror silently routed
 *  tabs frames into the recently_closed shelf under pk 'entryId', fabricating phantom
 *  rows ONLY in the replay model. Typed Record<ViewName, ...> below makes any future
 *  view growth a compile error here, never a silent misroute. */
const replayFrames = (frames: readonly ViewDeltaFrame[]): string => {
  const stores: Record<ViewDeltaFrame['view'], Map<string, unknown>> = {
    missions: new Map(),
    recentlyClosed: new Map(),
    sessions: new Map(),
    tabs: new Map(),
  };
  // Mirror of the engine's patch law (engine.ts: patch re-adds the store pk), pk naming
  // per projector declaration (ProjectorDef.keyField; sessions upsert carries its
  // compound pk inside the record, a patch branch never addresses it).
  const pkOf = (view: ViewDeltaFrame['view']): string =>
    view === 'missions'
      ? 'missionId'
      : view === 'tabs'
        ? 'ledgeTabId'
        : view === 'sessions'
          ? 'snapshotId'
          : 'entryId';
  for (const frame of frames) {
    const store = stores[frame.view];
    for (const op of frame.ops) {
      if (op.kind === 'upsert') store.set(op.key, { ...(op.record as Record<string, unknown>) });
      if (op.kind === 'remove') store.delete(op.key);
      if (op.kind === 'patch') {
        const cur = (store.get(op.key) ?? {}) as Record<string, unknown>;
        store.set(op.key, { ...cur, ...op.fields, [pkOf(frame.view)]: op.key });
      }
    }
  }
  return stableStringify({
    missions: shelfCanon([...stores.missions.values()]),
    recently_closed: shelfCanon([...stores.recentlyClosed.values()]),
    sessions: shelfCanon([...stores.sessions.values()]),
    tabs: shelfCanon([...stores.tabs.values()]),
  });
};

/** REGRESSION LOCK (fc-seed-−1953314806, CI property gate): the shrunk counterexample
 *  [formed(m1,[t5]), renamed(m1)]. Class: the delta-replay mirror's view mapping was
 *  NOT ViewName-total — tabs frames misrouted into the recently_closed shelf. This is
 *  the per-message minimal reproducer (deterministic, sub-second) the property hangs on. */
describe('E2-T10 regression — tabs-view mirror totality (fc-seed-−1953314806)', () => {
  it('formed→renamed replay keeps all FOUR shelves frame-faithful (never a phantom row)', async () => {
    const events = streamOf([
      { kind: 'formed', m: 1, tabs: [5] },
      { kind: 'renamed', m: 1 },
    ]);
    const a = await makeProjections();
    try {
      await seedJournal(a, events);
      unwrap(await a.projections.applyFromJournal(DEV_A), 'apply');
      const snapA = await snapshotAll(a);
      expect(replayFrames(a.frames)).toBe(snapA);
      // The bug's fingerprint, pinned literally: no tab-keyed phantom in recently_closed.
      const parsed = JSON.parse(snapA) as { readonly recently_closed: readonly unknown[] };
      expect(parsed.recently_closed.length).toBe(0);
    } finally {
      await a.engine.close();
    }
  });
});

describe('E2-T10 property — replay invariants across engines + reset boundaries', () => {
  it(
    'same journal ⇒ identical models; watermarks ride the head; rebuild ≡ live; deltas alone rebuild the stores',
    { timeout: PROP_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 24 }), async (ops) => {
          const events = streamOf(ops);
          const head = events.length;

          const a = await makeProjections();
          const b = await makeProjections();
          try {
            await seedJournal(a, events);
            await seedJournal(b, events);
            unwrap(await a.projections.applyFromJournal(DEV_A), 'apply A');
            unwrap(await b.projections.applyFromJournal(DEV_A), 'apply B');

            // Determinism: independent engines replay to identical models.
            const snapA = await snapshotAll(a);
            expect(await snapshotAll(b)).toBe(snapA);

            // Watermark correctness: every stamped watermark rides the true
            // applied head (never short, never past).
            const status = unwrap(await a.projections.status(), 'status');
            for (const viewStatus of status.views) {
              const wm = viewStatus.watermarks.at(0);
              expect(wm, `watermark missing for ${viewStatus.view}`).toBeDefined();
              expect(wm?.seq).toBe(head);
            }

            // Snapshot equivalence (disposable law): rebuild replays the
            // journal and lands on byte-identical models.
            unwrap(await a.projections.rebuild('missions'), 'rebuild');
            expect(await snapshotAll(a)).toBe(snapA);

            // Δ faithfulness: published frames alone reconstruct the stores.
            expect(replayFrames(a.frames)).toBe(snapA);
          } finally {
            await a.engine.close();
            await b.engine.close();
          }
        }),
      );
    },
  );
});
