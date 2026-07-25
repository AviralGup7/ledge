// E2-T09 · chaos harness v1 (EES §8 tooling: "custom driver + fixtures"; gate:
// nightly + release; M1 exit row: "chaos 0-loss… nothing user-facing without
// G1"). This suite binds the mission's three fronts into the CI-runnable form:
//
//   A. points.txt FULLY AUTOMATED — the manifest binds every enumerated line;
//      constitution below is fail-closed (orphan line / phantom binding = red).
//   B. KILL-POINT SWEEP — every point is driven through its owner's torn-state
//      fixture/markers and the outcome must land the resolution law.
//   C. FAULT INJECTION — seeded IDB latency is deterministic AND outcome-
//      invariant; a planned one-shot failure surfaces typed + annotated and is
//      reversible (retry on the unwrapped engine succeeds).
//   D. CORRUPTED-JOURNAL SEEDS — detection, prefix honesty, overlap refusal,
//      conservative degrade, zero writes.
//   E. G1 EVIDENCE — the full sweep folds into a deterministic, clock-free
//      report; byte-equality with the committed golden is the reproducibility
//      gate. Refresh: UPDATE_EVIDENCE=1 pnpm test:chaos (a reviewed act).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { openEngine } from '@/infrastructure/journal/core/testkit.js';
import {
  CORRUPTED_SEEDS,
  runCorruptedSeed,
  runFullSweep,
  runMarkerPoint,
  runReconcilerPoint,
} from '../../chaos/driver.js';
import {
  buildEvidence,
  serializeEvidence,
  type ChaosEvidenceReportV1,
} from '../../chaos/evidence.js';
import { withFaults } from '../../chaos/faults.js';
import { MARKER_POINT_EXPECTATIONS, POINT_BINDINGS } from '../../chaos/manifest.js';
import { readKillPoints, readKillPointsNormative } from '../../chaos/points-file.js';
import {
  makeWorld,
  PARK_POINT_SCOPE_REFS,
  reconcile,
  type KillPointFixture,
} from '@/infrastructure/recovery/reconciler/testkit.js';
import { BOOT_MARKER_KILL_POINTS } from '@/infrastructure/recovery/marker/testkit.js';

const EVIDENCE_URL = new URL('../../chaos/evidence/g1-chaos-evidence.v1.json', import.meta.url);

const LATENCY_SEED = 42;
const LATENCY_MAX_MS = 3;
const FAULT_ORDINAL = 1;

/** Zero-tab-loss accounting mirror (the owner suite's law, restated per disposition). */
const expectZeroLoss = (
  fixture: KillPointFixture,
  outcome: Awaited<ReturnType<typeof runReconcilerPoint>>,
): void => {
  const refs = fixture.scopeRefs ?? 0;
  if (outcome.disposition === 'completed-evidence') {
    expect(outcome.securedCounted).toBe(refs);
    expect(outcome.liveLeftOpen).toBe(0);
  }
  if (outcome.disposition === 'aborted-conservative') {
    expect(outcome.evidenceTabs.length + outcome.liveLeftOpen).toBe(refs);
  }
  if (outcome.disposition === 'completed-safe' || outcome.disposition === 'deferred') {
    expect(outcome.securedCounted).toBe(0);
    expect(outcome.liveLeftOpen).toBe(0);
  }
};

describe('E2-T09 harness — constitution (points.txt fully automated)', () => {
  it('manifest binds exactly the points.txt set — no orphan lines, no phantom bindings', () => {
    const file = readKillPoints();
    const bound = POINT_BINDINGS.map((b) => b.point);
    expect(new Set(bound).size, 'a point is bound twice').toBe(bound.length);
    expect([...bound].sort()).toEqual([...file].sort());
  });

  it('owner partition is exactly the suites’ partitions (flow-partition law)', () => {
    const reconcilerPoints = POINT_BINDINGS.filter((b) => b.owner === 'reconciler').map(
      (b) => b.point,
    );
    const markerPoints = POINT_BINDINGS.filter((b) => b.owner === 'marker').map((b) => b.point);
    expect([...markerPoints].sort()).toEqual([...BOOT_MARKER_KILL_POINTS].sort());
    // The reconciler half derives from the owner suite's own fixture catalog;
    // cross-exactness with RECONCILER_KILL_POINTS is constitution-asserted in
    // the owner suites (both directions), and re-pinned here via the file.
    expect(reconcilerPoints.every((p) => readKillPoints().includes(p))).toBe(true);
  });

  it('every marker point carries an expectation (fail-closed binding)', () => {
    for (const point of BOOT_MARKER_KILL_POINTS) {
      expect(MARKER_POINT_EXPECTATIONS[point], `no expectation for ${point}`).toBeDefined();
    }
  });

  it('points.txt normalization is stable (digest input is reproducible)', () => {
    expect(readKillPointsNormative()).toBe(readKillPointsNormative());
  });
});

describe('E2-T09 driver — kill-point sweep (reconciler-owned)', () => {
  const reconcilerFixtures = POINT_BINDINGS.filter(
    (b): b is Extract<typeof b, { owner: 'reconciler' }> => b.owner === 'reconciler',
  );
  expect(reconcilerFixtures).toHaveLength(readKillPoints().length - BOOT_MARKER_KILL_POINTS.length);

  for (const binding of reconcilerFixtures) {
    it(`${binding.point} ⇒ ${binding.fixture.expected.disposition ?? 'clean'}`, async () => {
      const outcome = await runReconcilerPoint(binding.fixture);
      // Resolution law: disposition + disposition-class zero-loss accounting.
      expect(outcome.disposition).toBe(binding.fixture.expected.disposition ?? 'none');
      expectZeroLoss(binding.fixture, outcome);
      if (binding.fixture.expected.disposition === null) {
        expect(outcome.outcome).toBe('clean');
        expect(outcome.lossRisk).toBe(false);
        expect(outcome.eventsWrittenByReconcile).toBe(0);
      } else {
        expect(outcome.outcome).toBe('reconciled');
        expect(outcome.intentsExamined).toBeGreaterThanOrEqual(1);
      }
    });
  }
});

describe('E2-T09 driver — kill-point sweep (marker-owned)', () => {
  const markerBindings = POINT_BINDINGS.filter(
    (b): b is Extract<typeof b, { owner: 'marker' }> => b.owner === 'marker',
  );

  for (const binding of markerBindings) {
    it(`${binding.point} ⇒ ${binding.expected.cause} (then ${binding.expected.followUpCause})`, async () => {
      const outcome = await runMarkerPoint(binding);
      expect(outcome.cause).toBe(binding.expected.cause);
      expect(outcome.copyKey).toBe(binding.expected.copyKey);
      expect(outcome.followUpCause).toBe(binding.expected.followUpCause);
    });
  }
});

describe('E2-T09 fault injection — IDB latency + planned failure (EES §8)', () => {
  const probeFixture = POINT_BINDINGS.filter(
    (b): b is Extract<typeof b, { owner: 'reconciler' }> => b.owner === 'reconciler',
  )
    .map((b) => b.fixture)
    .find((f) => f.point === 'park.commit-intent.after');
  if (probeFixture === undefined) throw new Error('probe fixture missing — harness bug');
  const fixture = probeFixture;

  it('pass-through: a fault-free proxy never changes the outcome', async () => {
    const inner = await openEngine();
    try {
      const proxied = withFaults(inner, {});
      const viaProxy = await runReconcilerPoint(fixture, { engine: proxied.engine });
      const direct = await runReconcilerPoint(fixture);
      expect(viaProxy).toEqual(direct);
    } finally {
      await inner.close();
    }
  });

  it('seeded latency is deterministic AND outcome-invariant', async () => {
    const runSeed = async (): Promise<{
      outcome: Awaited<ReturnType<typeof runReconcilerPoint>>;
      latencies: readonly { ordinal: number; op: string; latencyMs: number }[];
    }> => {
      const inner = await openEngine();
      try {
        const proxied = withFaults(inner, {
          latency: { seed: LATENCY_SEED, maxMs: LATENCY_MAX_MS },
        });
        const outcome = await runReconcilerPoint(fixture, { engine: proxied.engine });
        return { outcome, latencies: [...proxied.observed.ops] };
      } finally {
        await inner.close();
      }
    };
    const a = await runSeed();
    const b = await runSeed();
    expect(a.latencies).toEqual(b.latencies); // same seed ⇒ same injection stream
    expect(a.latencies.length).toBeGreaterThan(0);
    expect(a.outcome).toEqual(b.outcome);
    // Outcome-invariance: latency never changes the durability law.
    expect(a.outcome.disposition).toBe(fixture.expected.disposition);
  });

  it('a planned one-shot failure surfaces typed + annotated (never a field bug)', async () => {
    const inner: StorageEnginePort = await openEngine();
    try {
      const proxied = withFaults(inner, {
        failAt: { ordinal: FAULT_ORDINAL, code: 'E_QUOTA', what: 'idb-quota-exceeded' },
      });
      const r = await proxied.engine.txn(['meta'], 'readonly', async () => 0);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('E_QUOTA');
        expect(r.error.details?.['what']).toBe('idb-quota-exceeded');
        expect(r.error.details?.['chaosOp']).toContain('txn:');
        expect(r.error.details?.['chaosOrdinal']).toBe(FAULT_ORDINAL);
      }
      expect(proxied.observed.injectedOrdinal).toBe(FAULT_ORDINAL);
    } finally {
      await inner.close();
    }
  });

  it('a storage fault mid-reconcile degrades conservatively; unwrap ⇒ recovery (reversible)', async () => {
    const inner = await openEngine();
    try {
      // Phase the torn state through the PLAIN engine (fault at ordinal 1 would
      // kill the fixture's own first write — inject the fault only for the boot).
      const world = await makeWorld({ engine: inner });
      await fixture.setup(world);
      // Boot under the fault: the reconcile's FIRST op dies typed.
      const faulty = withFaults(inner, {
        failAt: { ordinal: FAULT_ORDINAL, code: 'E_QUOTA', what: 'idb-quota-exceeded' },
      });
      const faultyWorld = await makeWorld({ engine: faulty.engine });
      const degraded = await reconcile(faultyWorld);
      expect(degraded.ok).toBe(true);
      if (degraded.ok) {
        expect(degraded.value.outcome).toBe('recovered');
        expect(degraded.value.gaps.some((g) => g.includes('E_QUOTA'))).toBe(true);
        expect(degraded.value.resolutions).toEqual([]);
      }
      // Reversible: unwrap (a plain world over the SAME durable bytes) heals.
      const healWorld = await makeWorld({ engine: inner });
      const healed = await reconcile(healWorld);
      expect(healed.ok).toBe(true);
      if (healed.ok) {
        expect(healed.value.outcome).toBe('reconciled');
        expect(healed.value.resolutions[0]?.disposition).toBe(fixture.expected.disposition);
      }
    } finally {
      await inner.close();
    }
  });
});

describe('E2-T09 corrupted-journal seeds (EES §8 seeded truncations/bit-flips)', () => {
  for (const spec of CORRUPTED_SEEDS) {
    it(`${spec.seed} ${spec.damageClass}: detected, honest prefix, conservative, zero writes`, async () => {
      const outcome = await runCorruptedSeed(spec);
      expect(outcome.detected).toBe(true);
      expect(outcome.suspects, `suspects [${outcome.suspects.join(',')}]`).toContain(
        spec.expectSuspect,
      );
      expect(outcome.overlapRefused).toBe(spec.expectOverlapRefused);
      expect(outcome.prefixHonest).toBe(spec.hasHealthyPrefix ? true : 'none');
      // Conservative recovery: degraded boot NAMED at the expected read path,
      // outcome 'recovered', zero resolutions against unreadable truth.
      expect(outcome.degraded).toBe(spec.expectGapAt);
      expect(outcome.bootOutcome).toBe(spec.expectBootOutcome);
      expect(outcome.resolutionsIssued).toBe(0);
      expect(outcome.journalFrozen).toBe(true);
    });
  }
});

describe('E2-T09 determinism + G1 evidence', () => {
  const sweepOnce = async (): Promise<ChaosEvidenceReportV1> => buildEvidence(await runFullSweep());

  it('two independent sweeps produce byte-identical evidence bodies', async () => {
    const a = await sweepOnce();
    const b = await sweepOnce();
    expect(serializeEvidence(a)).toBe(serializeEvidence(b));
  });

  it('zero tab loss across the entire sweep (G1 0-loss gate)', async () => {
    const report = await sweepOnce();
    for (const kp of report.killPoints) {
      if (kp.owner !== 'reconciler') continue;
      if (kp.disposition === 'completed-evidence') {
        expect(kp.securedCounted).toBe(PARK_POINT_SCOPE_REFS);
      }
      if (kp.disposition === 'aborted-conservative') {
        expect(kp.evidenceTabs.length + kp.liveLeftOpen).toBe(PARK_POINT_SCOPE_REFS);
      }
    }
    for (const spec of CORRUPTED_SEEDS) {
      const seed = report.corruptedSeeds.find((row) => row.seed === spec.seed);
      expect(seed?.journalFrozen).toBe(true);
      expect(seed?.overlapRefused).toBe(spec.expectOverlapRefused);
    }
  });

  it('evidence report reproduces the committed golden (G1 reproducibility gate)', async () => {
    const report = await sweepOnce();
    const text = serializeEvidence(report);
    if (process.env['UPDATE_EVIDENCE'] === '1') {
      mkdirSync(new URL('./', EVIDENCE_URL), { recursive: true });
      writeFileSync(EVIDENCE_URL, text, 'utf8');
    }
    const golden = readFileSync(EVIDENCE_URL, 'utf8');
    expect(
      text,
      'G1 evidence drifted — if the change is INTENDED, refresh the golden with ' +
        'UPDATE_EVIDENCE=1 pnpm test:chaos and review the diff',
    ).toBe(golden);
  });
});
