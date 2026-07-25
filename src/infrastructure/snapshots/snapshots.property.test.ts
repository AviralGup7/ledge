// E2-T08 snapshot property suite — the R5/R4/§5 laws over randomized snapshot
// histories, proven against a model that restates the law FROM THE DOC TEXT
// (builder/projector helpers are never imported into the model):
//   P1 payload law: refs deduped order-stably; partCount == ceil(deduped/500);
//      styles pruned to ⊆ refs (empties kept); trigger always present.
//   P2 materialization law: store rows == canonical model chunks × partition,
//      apply-twice stable.
//   P3 completeness law: probe complete ⟺ no corruption LANDED — any seeded
//      corruption that mutates is ALWAYS prosecuted under its named kind.
//      (fast-check counterexample, seed -56493325: `drop-row` on an all-empty
//      history is a no-op — there is no row to drop — and the probe is CORRECT
//      to rule complete. The earlier model declared the world corrupt from the
//      corruption KIND instead of from whether it landed: model bug, not a
//      production defect. `extra-row` expectation derived from the DATA, not
//      case lore (seed -2106137212): this suite's generator starts snapshot
//      ids at snapshotIdOf(2), so the corruption's fallback target
//      snapshotIdOf(1) never has an event — an empty-world injection is an
//      `untracked-row`, an occupied one an `extra-part`. The model asks the
//      SCRIPT which verdict the probe must reach.)
//   P4 determinism: twin worlds run identical histories ⇒ identical rows+report.
//   P5 retention law: keep/purge partitions input; newest-per-mission ∈ keep;
//      purged ⇒ ¬newest ∧ age ≥ retention window.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { planRetention, SNAPSHOT_TRIGGERS } from './index.js';
import type { GroupStyle, SessionPartRow, SnapshotInput } from './types.js';
import {
  makeSnapshotWorld,
  snapshotIdOf,
  snapshotMissionId,
  snapshotTabId,
  SNAP_WALL_BASE,
} from './testkit.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`unexpected err ${r.error.code}`);
  return r.value;
};

// ---------------------------------------------------------------------------
// The model: §-law restated from R4/R5 text. Deliberately NOT the production fns.
// ---------------------------------------------------------------------------

const modelDedupe = (refs: readonly string[]): string[] => {
  const out: string[] = [];
  for (const r of refs) if (!out.includes(r)) out.push(r);
  return out;
};

const modelPruneStyles = (styles: readonly GroupStyle[], refs: readonly string[]): GroupStyle[] =>
  styles.map((s) => ({ ...s, tabOrder: s.tabOrder.filter((id) => refs.includes(id)) }));

interface ModelPart {
  readonly partIndex: number;
  readonly ids: readonly string[];
  readonly styles: readonly GroupStyle[];
}

const modelParts = (refs: readonly string[], styles: readonly GroupStyle[]): ModelPart[] => {
  const parts: ModelPart[] = [];
  for (let start = 0, idx = 0; start < refs.length; start += 500, idx += 1) {
    const ids = refs.slice(start, start + 500);
    parts.push({
      partIndex: idx,
      ids,
      styles: styles.filter((s) => s.tabOrder.some((id) => ids.includes(id))),
    });
  }
  return parts;
};

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

// Indexed access under noUncheckedIndexedAccess without non-null assertions:
// every use site is inside a generator/invariant-guarded loop, so a miss is a
// test-harness bug and must throw LOUDLY, never be asserted away.
const atIndex = <T>(arr: readonly T[], i: number): T => {
  const v = arr[i];
  if (v === undefined) throw new Error(`harness index ${i} out of bounds (len ${arr.length})`);
  return v;
};

const tabPool = (n: number) => Array.from({ length: n }, (_, i) => snapshotTabId(i + 1) as string);

const REF_COUNTS = [0, 1, 2, 3, 499, 500, 501, 999, 1000, 1001, 1200] as const;

const snapshotArb = (snapshotN: number, missionN: number): fc.Arbitrary<SnapshotInput> =>
  fc
    .tuple(
      fc.constantFrom(...REF_COUNTS),
      fc.integer({ min: 0, max: 5 }), // duplicate injections
      fc.integer({ min: 0, max: 3 }), // style count
      fc.integer({ min: 0, max: 4 }), // orphan refs inside styles
      fc.constantFrom(...SNAPSHOT_TRIGGERS),
      fc.integer({ min: 0, max: 1_000_000 }),
    )
    .map(([refCount, dups, styleCount, orphans, trigger, takenOffset]) => {
      const pool = tabPool(Math.max(refCount, 3));
      const refs = pool.slice(0, refCount);
      const withDups = [...refs];
      for (let i = 0; i < dups && withDups.length > 0; i += 1) {
        withDups.splice(
          Math.min(i, withDups.length - 1),
          0,
          atIndex(withDups, i % withDups.length),
        );
      }
      const orphanIds = Array.from({ length: orphans }, (_, i) => snapshotTabId(900 + i) as string);
      const styles: GroupStyle[] = Array.from({ length: styleCount }, (_, g) => ({
        groupId: g + 1,
        name: g % 2 === 0 ? `g${g}` : '',
        color: g % 2 === 0 ? 'blue' : '',
        collapsed: g % 3 === 0,
        tabOrder: [...refs.filter((_, i) => i % (g + 1) === 0).slice(0, 5), ...orphanIds],
      }));
      return {
        snapshotId: snapshotIdOf(snapshotN + 1),
        missionId: snapshotMissionId(missionN + 1),
        tabRecordIds: withDups as never,
        groupStyles: styles,
        takenAt: SNAP_WALL_BASE + takenOffset,
        trigger,
      };
    });

type Corruption =
  | { readonly kind: 'none' }
  | { readonly kind: 'drop-row' }
  | { readonly kind: 'extra-row' }
  | { readonly kind: 'tamper-ids' };

const corruptionArb: fc.Arbitrary<Corruption> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'none' } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: 'drop-row' } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: 'extra-row' } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: 'tamper-ids' } as const) },
);

interface Script {
  readonly snapshots: readonly SnapshotInput[];
  readonly corruption: Corruption;
}

const scriptArb: fc.Arbitrary<Script> = fc
  .integer({ min: 1, max: 3 })
  .chain((count) =>
    fc.tuple(
      fc.tuple(...Array.from({ length: count }, (_, i) => snapshotArb(i + 1, i % 2))),
      corruptionArb,
    ),
  )
  .map(([snaps, corruption]) => ({ snapshots: snaps, corruption }));

// ---------------------------------------------------------------------------
// The world run + law machine.
// ---------------------------------------------------------------------------

const runScript = async (script: Script) => {
  const w = await makeSnapshotWorld();
  for (const snap of script.snapshots) {
    await w.takeSnapshot(snap);
  }
  await w.applyProjections();
  // P1 against the JOURNAL stream (payload as appended).
  const events = (await w.readAll())
    .filter((e) => e.envelope.type === 'SnapshotTaken')
    .map((e) => e.envelope.payload as Record<string, unknown>);
  const rows = await w.partRows();

  // P2 model rows.
  const modelRowsBySnapshot = new Map<string, ModelPart[]>();
  script.snapshots.forEach((snap) => {
    const deduped = modelDedupe(snap.tabRecordIds as readonly string[]);
    const pruned = modelPruneStyles(snap.groupStyles, deduped);
    modelRowsBySnapshot.set(snap.snapshotId as string, modelParts(deduped, pruned));
  });

  for (const snap of script.snapshots) {
    const deduped = modelDedupe(snap.tabRecordIds as readonly string[]);
    const appended = events.find((p) => p['snapshotId'] === (snap.snapshotId as string));
    expect(appended, 'snapshot event must exist').toBeDefined();
    // P1 payload laws.
    expect(appended?.['tabRecordRefs']).toEqual(deduped);
    expect(appended?.['partCount']).toBe(Math.ceil(deduped.length / 500));
    const pStyles = appended?.['groupStyles'] as readonly GroupStyle[];
    for (const s of pStyles) {
      for (const id of s.tabOrder) expect(deduped).toContain(id);
    }
    expect(appended?.['trigger']).toBe(snap.trigger);
    // P2 row laws for this snapshot.
    const actualParts = rows
      .filter((r) => r.snapshotId === (snap.snapshotId as string))
      .sort((a, b) => a.partIndex - b.partIndex);
    const modelPartsList = modelRowsBySnapshot.get(snap.snapshotId as string) ?? [];
    expect(actualParts).toHaveLength(modelPartsList.length);
    actualParts.forEach((row, i) => {
      const mp = atIndex(modelPartsList, i);
      expect(row.partIndex).toBe(mp.partIndex);
      expect(row.tabRecordIds).toEqual(mp.ids);
      expect(row.groupStyles).toEqual(mp.styles);
      expect(row.takenAt).toBe(snap.takenAt);
      expect(row.trigger).toBe(snap.trigger);
      expect(row.missionId).toBe(snap.missionId as string);
    });
  }

  // Apply-twice stability (rows byte-identical after a second drive).
  await w.applyProjections();
  expect(await w.partRows()).toEqual(rows);

  // P3 corruption prosecution.
  const corrupted = { expectedKinds: new Set<string>(), mutated: false };
  await applyCorruption(w, rows, script, corrupted);
  const report = unwrap(await w.probe());
  const reportKinds = new Set(report.issues.map((i) => i.kind));
  // The verdict law keys on whether corruption LANDED, not on its kind: a
  // no-op seeding (e.g. drop-row on an empty history) leaves a clean world.
  const clean = !corrupted.mutated;
  expect(report.complete).toBe(clean);
  for (const k of corrupted.expectedKinds) {
    expect(reportKinds.has(k as never), `corruption class ${k} must be prosecuted`).toBe(true);
  }
  if (clean) expect(report.issues).toEqual([]);

  // P4 twin determinism (rows + probe verdict).
  const twin = await makeSnapshotWorld();
  for (const snap of script.snapshots) await twin.takeSnapshot(snap);
  await twin.applyProjections();
  expect(await twin.partRows()).toEqual(rows);
  expect(unwrap(await twin.probe()).complete).toBe(true);

  await w.engine.close();
  await twin.engine.close();
};

const applyCorruption = async (
  w: Awaited<ReturnType<typeof makeSnapshotWorld>>,
  rows: readonly SessionPartRow[],
  script: Script,
  sink: { expectedKinds: Set<string>; mutated: boolean },
): Promise<void> => {
  const first = rows[0];
  switch (script.corruption.kind) {
    case 'none':
      return;
    case 'drop-row':
      if (first === undefined) return; // empty part world: nothing to drop
      await w.deleteRow(first.snapshotId, first.partIndex);
      sink.mutated = true;
      sink.expectedKinds.add('missing-part');
      return;
    case 'extra-row': {
      // Occupied world: ride on an existing snapshot (partIndex above its own
      // ceiling ⟹ extra-part — its max ≤ the global max, so maxIdx+1 always
      // clears it). Empty world: snapshotIdOf(1), which this generator never
      // snaps (ids start at snapshotIdOf(2)) ⟹ untracked-row. The verdict is
      // derived from the script, not from lore about the generator.
      const snapN = first?.snapshotId ?? (snapshotIdOf(1) as string);
      const maxIdx = rows.reduce((m, r) => Math.max(m, r.partIndex), -1);
      await w.putRow({
        snapshotId: snapN,
        partIndex: maxIdx + 1,
        missionId: snapshotMissionId(1) as string,
        tabRecordIds: [],
        groupStyles: [],
        takenAt: 0,
      });
      sink.mutated = true;
      const tracked = script.snapshots.some((s) => (s.snapshotId as string) === snapN);
      sink.expectedKinds.add(tracked ? 'extra-part' : 'untracked-row');
      return;
    }
    case 'tamper-ids':
      if (first === undefined || first.tabRecordIds.length === 0) return;
      await w.putRow({
        ...first,
        tabRecordIds: [...first.tabRecordIds, snapshotTabId(700) as string],
      });
      sink.mutated = true;
      sink.expectedKinds.add('chunk-pattern');
      return;
  }
};

// World-scale runs (open engine + projections + probe + twin) are heavy; the
// PR/nightly lanes multiply numRuns ×2/×20, so the timeout follows the
// established property-suite convention (see projections.property.test.ts).
const PROP_TIMEOUT_MS = 600_000;

describe('E2-T08 property — randomized snapshot histories', () => {
  it(
    'every history meets P1 payload, P2 materialization, P3 prosecution, P4 determinism',
    async () => {
      await fc.assert(
        fc.asyncProperty(scriptArb, async (script) => {
          await runScript(script);
        }),
      );
    },
    PROP_TIMEOUT_MS,
  );

  it(
    'retention partitions input, preserves newest-per-mission, respects the window (P5)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.integer({ min: 1, max: 4 }),
              fc.integer({ min: 0, max: 365 }),
              fc.integer({ min: 1, max: 50 }),
            ),
            { minLength: 0, maxLength: 40 },
          ),
          fc.integer({ min: 0, max: 20 }),
          async (raw, retentionDays) => {
            const now = 500 * 24 * 60 * 60 * 1_000;
            const DAY = 24 * 60 * 60 * 1_000;
            const snaps = raw.map(([mission, ageDays, n]) => ({
              missionId: `m${mission}`,
              snapshotId: `s${n}-${mission}-${ageDays}`,
              takenAt: now - ageDays * DAY,
            }));
            const plan = planRetention(snaps, now, Math.max(retentionDays, 1));
            const all = snaps.map((s) => s.snapshotId);
            expect([...plan.keep, ...plan.purge].sort()).toEqual([...all].sort());
            const keepSet = new Set(plan.keep);
            const byMission = new Map<string, typeof snaps>();
            for (const s of snaps) {
              const l = byMission.get(s.missionId) ?? [];
              l.push(s);
              byMission.set(s.missionId, l);
            }
            for (const list of byMission.values()) {
              // byMission lists are non-empty by construction (push-on-first-set).
              const newest = [...list].sort(
                (a, b) => b.takenAt - a.takenAt || (a.snapshotId < b.snapshotId ? -1 : 1),
              )[0];
              if (newest === undefined) throw new Error('byMission list empty — harness bug');
              expect(keepSet.has(newest.snapshotId)).toBe(true);
            }
            for (const s of snaps) {
              if (!keepSet.has(s.snapshotId)) {
                expect(now - s.takenAt).toBeGreaterThanOrEqual(Math.max(retentionDays, 1) * DAY);
              }
            }
          },
        ),
      );
    },
    PROP_TIMEOUT_MS,
  );
});
