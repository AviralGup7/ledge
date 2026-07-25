// E2-T08 chaos — snapshot durability boundaries. The snapshot flow's two true
// boundaries are FAMILY laws already owned elsewhere (event-append: the park.*
// kill points, E2-T06; materialization: the projection engine's chunked-txn
// resume law, E2-T03), so no new lines land in ops/chaos/points.txt — this
// suite proves the recovery-side invariant over them:
//
//   EVERY torn state a kill can leave is NAMED EXACTLY by the part-completeness
//   probe, the probe is idempotent and side-effect-free, and the sanctioned
//   repair path (watermark catch-up / rebuild-unfreeze) restores completeness.
import { describe, expect, it } from 'vitest';
import type { ProjectorDef } from '@/application/ports/projection-engine.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import {
  buildSnapshotPayload,
  chunkRefs,
  sessionsProjector,
  SNAPSHOT_CHUNK_SIZE,
  stylesForPart,
} from './index.js';
import type { SnapshotInput } from './types.js';
import { V1_PROJECTORS } from '@/infrastructure/projections/index.js';
import {
  DEV_A,
  makeSnapshotWorld,
  snapshotIdOf,
  snapshotMissionId,
  snapshotTabId,
  SNAP_WALL_BASE,
  styleOf,
} from './testkit.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

const ids = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => snapshotTabId(offset + i + 1));

const input = (n: number, snapshotN: number, missionN = 1): SnapshotInput => ({
  snapshotId: snapshotIdOf(snapshotN),
  missionId: snapshotMissionId(missionN),
  tabRecordIds: ids(n, snapshotN * 100),
  groupStyles: [styleOf(snapshotN, ids(Math.min(n, 3), snapshotN * 100))],
  takenAt: SNAP_WALL_BASE + snapshotN,
  trigger: 'crash',
});

describe('E2-T08 chaos — torn materialization states', () => {
  it('C1: kill post-append, pre-materialize ⇒ probe names every part missing; catch-up heals', async () => {
    const w = await makeSnapshotWorld();
    // Event durable, projector never ran (the SW died between the two phases).
    await w.takeSnapshot(input(SNAPSHOT_CHUNK_SIZE + 10, 1));
    let report = unwrap(await w.probe());
    expect(report.complete).toBe(false);
    expect(report.issues.filter((i) => i.kind === 'missing-part')).toEqual([
      { kind: 'missing-part', snapshotId: snapshotIdOf(1) as string, partIndex: 0 },
      { kind: 'missing-part', snapshotId: snapshotIdOf(1) as string, partIndex: 1 },
    ]);
    // Boot-time projection catch-up (the engine's resume law) heals exactly.
    await w.applyProjections();
    report = unwrap(await w.probe());
    expect(report.complete).toBe(true);
    expect((await w.partRows()).map((r) => r.tabRecordIds.length)).toEqual([
      SNAPSHOT_CHUNK_SIZE,
      10,
    ]);
  });

  it('C2: partial store (K of N parts seeded) ⇒ probe names exactly the tail as missing', async () => {
    const w = await makeSnapshotWorld();
    const snapN = 2;
    await w.takeSnapshot(input(SNAPSHOT_CHUNK_SIZE * 3, snapN)); // 3 parts expected
    // Torn apply: parts 0..1 landed, part 2 never did (foreign/corrupt history).
    const all = await w.partRows();
    expect(all).toHaveLength(0); // never applied — seed the torn store by hand
    const full = unwrap(buildSnapshotPayload(input(SNAPSHOT_CHUNK_SIZE * 3, snapN)));
    const chunks = chunkRefs(full.payload.tabRecordRefs);
    for (let partIndex = 0; partIndex < 2; partIndex += 1) {
      const refs = chunks[partIndex] ?? [];
      await w.putRow({
        snapshotId: snapshotIdOf(snapN) as string,
        partIndex,
        missionId: snapshotMissionId(1) as string,
        tabRecordIds: refs,
        groupStyles: stylesForPart(full.payload.groupStyles, refs),
        takenAt: SNAP_WALL_BASE + snapN,
        trigger: 'crash',
      });
    }
    const report = unwrap(await w.probe());
    expect(report.complete).toBe(false);
    expect(report.issues).toEqual([
      { kind: 'missing-part', snapshotId: snapshotIdOf(snapN) as string, partIndex: 2 },
    ]);
  });

  it('C3: projector-throw boundary ⇒ dirty freeze + probe names the gap; rebuild unfreezes to complete', async () => {
    // SessionsView throws on the SECOND SnapshotTaken it sees (mid-chunk kill
    // inside one txn: earlier event's rows exist, the failing event's don't,
    // the view is marked dirty and freezes per §2.10's failure law).
    let seen = 0;
    const throwingSessions: ProjectorDef = {
      ...sessionsProjector,
      project: async (event, read) => {
        if (event.type === 'SnapshotTaken') {
          seen += 1;
          if (seen === 2) throw new Error('projector death');
        }
        return sessionsProjector.project(event, read);
      },
    };
    const others = V1_PROJECTORS.filter((p) => p.view !== 'sessions');
    const w = await makeSnapshotWorld({ projectors: [...others, throwingSessions] });
    await w.takeSnapshot(input(5, 1));
    await w.takeSnapshot(input(7, 2));
    const applied = unwrap(await w.projections.applyFromJournal(DEV_A));
    expect(applied.dirtied).toContain('sessions');
    // Snapshot 1 materialized; snapshot 2's rows never landed.
    expect((await w.partRows()).map((r) => r.snapshotId)).toEqual([snapshotIdOf(1) as string]);
    const torn = unwrap(await w.probe());
    expect(torn.complete).toBe(false);
    expect(torn.issues).toEqual([
      { kind: 'missing-part', snapshotId: snapshotIdOf(2) as string, partIndex: 0 },
    ]);
    // Watermark catch-up is (correctly) frozen on a dirty view — rebuild is
    // the sanctioned unfreeze+repair, and it converges the store exactly.
    unwrap(await w.projections.rebuild('sessions'));
    expect(unwrap(await w.probe()).complete).toBe(true);
    expect(await w.partRows()).toHaveLength(2);
  });

  it('C4: probe idempotence under arbitration — a torn report is stable until state changes', async () => {
    const w = await makeSnapshotWorld();
    await w.takeSnapshot(input(3, 1));
    await w.applyProjections();
    await w.deleteRow(snapshotIdOf(1) as string, 0);
    const a = unwrap(await w.probe());
    const b = unwrap(await w.probe());
    expect(b).toEqual(a);
    expect(b.issues).toEqual([
      { kind: 'missing-part', snapshotId: snapshotIdOf(1) as string, partIndex: 0 },
    ]);
  });
});
