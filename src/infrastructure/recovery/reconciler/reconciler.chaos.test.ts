// E2-T06 chaos — kill-point matrix. Completion criterion of the roadmap task:
// EVERY point in ops/chaos/points.txt resolves correctly. Fixtures build the exact
// durable state a kill at that boundary leaves (torn flows are assembled half-by-
// half through the real journal + ledger), the reconciler runs over it, and the
// assertions are the point's resolution law. Every point also proves: zero tab
// loss accounting, second-reconcile idempotence, and BootReport presence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  acceptIntent,
  browserTabId,
  KILL_POINT_FIXTURES,
  makeWorld,
  missionId,
  observeThenClose,
  reconcile,
  RECONCILER_KILL_POINTS,
  tabsParked,
} from './testkit.js';
import type { BootReport } from './types.js';

const unwrap = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(`unexpected err: ${JSON.stringify(r.error)}`);
  return r.value;
};

// The point ⇒ (torn-state, expectation) binding lives in the testkit catalog
// (KILL_POINT_FIXTURES): ONE definition consumed by this suite (law depth) and
// by the E2-T09 harness driver in ops/chaos (sweep + G1 evidence). A fixture
// added here without the catalog — or vice versa — fails the coverage it below.
const FIXTURES = KILL_POINT_FIXTURES;

/** Every enumerated point must exist in ops/chaos/points.txt (PR-template law). */
const pointsFile = (): string[] =>
  readFileSync(new URL('../../../../ops/chaos/points.txt', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

describe('E2-T06 chaos — kill-point matrix (ops/chaos/points.txt)', () => {
  it('fixtures cover exactly this suite’s owned kill points (flow-partition law)', () => {
    // Ownership partition: the reconciler owns RECONCILER_KILL_POINTS; boot.*
    // points belong to the marker suite (E2-T07); compact.* points to the
    // journal compaction suite (E2-T11). Cross-suite partition
    // exactness (file == both owners, disjoint) is constitution-asserted in
    // the marker chaos suite — an orphan file line fails there; a phantom or
    // missing reconciler fixture fails HERE.
    expect(FIXTURES.map((f) => f.point).sort()).toEqual([...RECONCILER_KILL_POINTS].sort());
    const file = new Set(pointsFile());
    for (const point of RECONCILER_KILL_POINTS) {
      expect(file.has(point), `kill point ${point} missing from ops/chaos/points.txt`).toBe(true);
    }
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.point} ⇒ ${fixture.expected.disposition ?? 'clean'}`, async () => {
      const w = await makeWorld();
      const id = await fixture.setup(w);
      const fixtureEvents = (await w.readAll()).length;

      const report = unwrap(await reconcile(w));
      expect(report.schemaV).toBe(1);

      if (fixture.expected.disposition === null) {
        expect(report.outcome).toBe('clean');
        expect(report.lossRisk).toBe(false);
        expect(report.resolutions).toEqual([]);
        expect((await w.readAll()).length).toBe(fixtureEvents);
      } else {
        expect(report.outcome).toBe('reconciled');
        const resolutions = report.resolutions.filter((r) => r.intentId === id);
        expect(resolutions).toHaveLength(1);
        const [res] = resolutions;
        expect(res?.disposition).toBe(fixture.expected.disposition);
        const row = await w.row(id as never);
        expect(row.state).toBe(fixture.expected.state);

        // Zero tab loss law (park points), disposition-exact:
        //  - completed-evidence:            secured == refs (each counted once), 0 left.
        //  - aborted-conservative (partial): secured + liveLeftOpen == refs.
        //  - completed-safe:                row reflects the durable already-counted
        //    completion (counting happened pre-crash); 0 newly secured, 0 left.
        if (fixture.scopeRefs !== undefined && res !== undefined) {
          if (res.disposition === 'completed-evidence') {
            expect(res.securedCounted).toBe(fixture.scopeRefs);
            expect(res.liveLeftOpen).toBe(0);
          }
          if (res.disposition === 'aborted-conservative') {
            expect(res.evidenceTabs.length + res.liveLeftOpen).toBe(fixture.scopeRefs);
            // Partial branch: SOMETHING closed externally, SOMETHING left open —
            // and the union is exactly the scope (no foreign tabs, no double count).
            if (fixture.point.includes('mid-batch')) {
              expect(res.evidenceTabs.length).toBeGreaterThan(0);
              expect(res.liveLeftOpen).toBeGreaterThan(0);
            }
          }
          if (res.disposition === 'completed-safe') {
            expect(res.securedCounted).toBe(0);
            expect(res.liveLeftOpen).toBe(0);
          }
          if (res.disposition === 'deferred') {
            expect(res.securedCounted).toBe(0);
            expect(res.liveLeftOpen).toBe(0);
          }
        }
        // Deferred points: nothing written for the intent, row untouched.
        if (res?.disposition === 'deferred') {
          expect(row.retryCount).toBeGreaterThanOrEqual(1);
          expect(report.lossRisk).toBe(true);
        }
        // Conservative boundary: partial evidence NEVER completes.
        if (fixture.point.endsWith('mid-batch') || fixture.point.endsWith('.mid')) {
          expect(res?.disposition).not.toBe('completed-evidence');
          expect(res?.disposition).not.toBe('completed-safe');
        }
      }

      // Idempotence law at EVERY point: a second boot changes nothing.
      const settled = (await w.readAll()).length;
      const again = unwrap(await reconcile(w));
      expect(
        again.resolutions.filter((r) => r.intentId === id && r.disposition !== 'deferred'),
      ).toEqual([]);
      expect((await w.readAll()).length).toBe(settled);
    });
  }

  it('mixed wreckage: torn-complete + partial-park + delete + resume resolve independently in one boot', async () => {
    const w = await makeWorld();
    // torn park complete
    const torn = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    await observeThenClose(w, [1]);
    await w.append([tabsParked(w, torn, 1)]);
    // partial park
    const partial = await acceptIntent(w, 2, 'ParkAll', {
      tabIds: [browserTabId(2), browserTabId(3)],
    });
    await observeThenClose(w, [2]);
    // delete pending
    const del = await acceptIntent(w, 3, 'DeleteEntity', { kind: 'mission', id: missionId(1) });
    // resume pending
    const res = await acceptIntent(w, 4, 'ResumeMission', {
      missionId: missionId(2),
      mode: 'partial',
    });

    const report = unwrap(await reconcile(w));
    expect(report.outcome).toBe('reconciled');
    expect(report.intentsExamined).toBe(4);
    const by = new Map(report.resolutions.map((r) => [r.intentId, r.disposition]));
    expect(by.get(torn)).toBe('completed-safe');
    expect(by.get(partial)).toBe('aborted-conservative');
    expect(by.get(del)).toBe('deferred');
    expect(by.get(res)).toBe('deferred');
    expect(report.lossRisk).toBe(true);

    // Ledger converged exactly as dispositioned; rows for deferred stay pending.
    expect((await w.row(torn)).state).toBe('done');
    expect((await w.row(partial)).state).toBe('aborted');
    expect((await w.row(del)).state).toBe('intent');
    expect((await w.row(res)).state).toBe('intent');

    // Stream head is exactly: fixture events + 1 restamp + 1 abort (deferreds write 0).
    const types = (await w.readAll()).map((e) => e.envelope.type);
    expect(types.filter((t) => t === 'TabsParked')).toHaveLength(2); // durable + restamp
    expect(types.filter((t) => t === 'ParkAborted')).toHaveLength(1);
    // Second boot converges nothing further.
    const again = unwrap(await reconcile(w));
    expect(again.outcome).toBe('reconciled'); // deferred intents still pending ⇒ examined
    expect(again.resolutions.every((r) => r.disposition === 'deferred')).toBe(true);
  });
});

// Report-shape guard copied into every point implicitly via unwrap — the report
// is the §14.4 contract surface, so its invariants get one direct test.
describe('E2-T06 — BootReport contract (v1)', () => {
  it('report envelope is stable: schemaV + gating fields + gaps always populated', async () => {
    const w = await makeWorld();
    const report: BootReport = unwrap(await reconcile(w));
    expect(Object.keys(report).sort()).toEqual(
      [
        'bootSignal', // E2-T07 · ADR-007/R16 marker signal (schema v1 completion)
        'bootTs',
        'crossCheck',
        'deviceId',
        'evidence',
        'gaps',
        'intentsExamined',
        'journalProbe',
        'lossRisk',
        'outcome',
        'projections',
        'resolutions',
        'schemaV',
      ].sort(),
    );
  });
});
