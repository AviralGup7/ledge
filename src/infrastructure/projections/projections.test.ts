// E2-T03 unit law tests (EES §2.10): watermark monotonicity, idempotent re-apply,
// delta publication shapes, dirty marking with peer isolation, resume-after-kill,
// rebuild determinism on a fixed journal.
import { describe, expect, it } from 'vitest';
import type { ProjectorDef } from '@/application/ports/projection-engine.port.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import { createProjectionEngine } from './core/engine.js';
import { V1_PROJECTORS } from './index.js';
import { missionsProjector } from './core/projectors/missions.projector.js';
import { recentlyClosedProjector } from './core/projectors/recently-closed.projector.js';
import {
  DEV_A,
  assignedEnv,
  closedEnv,
  formedEnv,
  makeProjections,
  missionId,
  movedEnv,
  renamedEnv,
  restoredEnv,
  seedJournal,
  storeSnapshot,
  tabId,
} from './testkit.js';
import { FRAME_OPS_CAP } from './core/types.js';

const missionRow = (rows: readonly StoredRecord[], id: string): StoredRecord | undefined =>
  rows.find((r) => r['missionId'] === id);

describe('§2.10 invariants', () => {
  it('apply projects missions + advances watermarks to the applied position', async () => {
    const h = await makeProjections();
    const r = await h.projections.apply([formedEnv(1, 1, [1, 2]), assignedEnv(2, 3, 1)]);
    if (!r.ok) throw new Error(`apply failed: ${r.error.code}`);
    expect(r.value.applied).toBe(2);
    const rows = await storeSnapshot(h, 'missions');
    const m1 = missionRow(rows, missionId(1));
    expect(m1?.['name']).toBe('mission-1');
    expect(m1?.['tabIds']).toEqual([tabId(1), tabId(2), tabId(3)]);
    const status = await h.projections.status();
    if (!status.ok) throw new Error('status failed');
    const missions = status.value.views.find((v) => v.view === 'missions');
    expect(missions?.dirty).toBe(false);
    expect(missions?.watermarks.at(0)?.seq).toBe(2);
    await h.engine.close();
  });

  it('idempotent re-apply: below-watermark events skip with zero new ops or frames', async () => {
    const h = await makeProjections();
    const events = [formedEnv(1, 1, [1]), renamedEnv(2, 1, 'renamed-once')];
    await h.projections.apply(events);
    const frameCount = h.frames.length;
    const again = await h.projections.apply(events);
    if (!again.ok) throw new Error('re-apply failed');
    expect(again.value.applied).toBe(2);
    expect(again.value.skippedBelowWatermark).toBeGreaterThan(0);
    expect(h.frames.length).toBe(frameCount);
    const m1 = missionRow(await storeSnapshot(h, 'missions'), missionId(1));
    expect(m1?.['name']).toBe('renamed-once');
    await h.engine.close();
  });

  it('regression (fc seed -159411701): rename-then-assign before formation never dirties the view', async () => {
    // The engine's patch law materializes a name-only row for the rename; the
    // assign must not dereference tabIds on that partial (dirty-law contract),
    // and formation closes the row out fully.
    const h = await makeProjections();
    const events = [renamedEnv(1, 1, 'early-name'), assignedEnv(2, 5, 1), formedEnv(3, 1, [1])];
    const r = await h.projections.apply(events);
    if (!r.ok) throw new Error(`apply failed: ${r.error.code}`);
    expect(r.value.dirtied).toEqual([]);
    const status = await h.projections.status();
    if (!status.ok) throw new Error('status failed');
    for (const view of status.value.views) {
      expect(view.dirty, `${view.view} dirtied on a lawful catalog stream`).toBe(false);
      expect(view.watermarks.at(0)?.seq).toBe(3);
    }
    // Forward tolerance: the provisional row is overwritten by the real
    // formation (assignment membership is not lost — formed lists tab 1 and
    // the provisional tab 5 was supplanted by the formed upsert, determinism).
    const m1 = missionRow(await storeSnapshot(h, 'missions'), missionId(1));
    expect(m1?.['name']).toBe('mission-1');
    expect(m1?.['tabIds']).toEqual([tabId(1)]);
    await h.engine.close();
  });

  it('TabMoved removes from the source mission and adds to the target (per-aggregate order)', async () => {
    const h = await makeProjections();
    await h.projections.apply([
      formedEnv(1, 1, [1, 2]),
      formedEnv(2, 2, [3]),
      movedEnv(3, 2, 2, 1),
    ]);
    const rows = await storeSnapshot(h, 'missions');
    expect(missionRow(rows, missionId(1))?.['tabIds']).toEqual([tabId(1)]);
    expect(missionRow(rows, missionId(2))?.['tabIds']).toEqual([tabId(3), tabId(2)]);
    await h.engine.close();
  });

  it('recently_closed: close enters, restore removes (separate store law)', async () => {
    const h = await makeProjections();
    await h.projections.apply([formedEnv(1, 1, [1]), closedEnv(2, 1, 1)]);
    let rows = await storeSnapshot(h, 'recently_closed');
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.['source']).toBe('external');
    expect(rows.at(0)?.['missionId']).toBe(missionId(1));
    await h.projections.apply([restoredEnv(3, 1, 1)]);
    rows = await storeSnapshot(h, 'recently_closed');
    expect(rows).toHaveLength(0);
    await h.engine.close();
  });

  it('delta frames carry view + watermark + ≤500 ops, published post-commit', async () => {
    const h = await makeProjections();
    // One event → one ops burst per view; a >frame-cap burst must split.
    const big = [
      formedEnv(
        1,
        1,
        Array.from({ length: 510 }, (_, i) => i + 1),
      ),
    ];
    await h.projections.apply(big);
    // formed upserts once (tabIds ride the same row); bursts beyond cap come from
    // many small events — generate 2 × FRAME_OPS_CAP + a tail via assignments.
    const burst = Array.from({ length: FRAME_OPS_CAP * 2 + 10 }, (_, i) =>
      assignedEnv(2 + i, (i % 40) + 1, 1),
    );
    const r = await h.projections.apply(burst);
    if (!r.ok) throw new Error('burst failed');
    for (const frame of h.frames) {
      expect(frame.ops.length).toBeLessThanOrEqual(FRAME_OPS_CAP);
      // Growth-lawful: frames may only carry REGISTERED views (E3-APP added 'tabs').
      expect(V1_PROJECTORS.map((p) => p.view)).toContain(frame.view);
      expect(frame.watermark.seq).toBeGreaterThan(0);
    }
    const missionsFrames = h.frames.filter((f) => f.view === 'missions');
    expect(missionsFrames.length).toBeGreaterThanOrEqual(2);
    await h.engine.close();
  });

  it('dirty law: a throwing projector freezes its view, peers march on; rebuild recovers', async () => {
    const h = await makeProjections();
    const venomous: ProjectorDef = {
      ...missionsProjector,
      async project(event, read) {
        if (event.type === 'MissionRenamed') throw new Error('venom');
        return missionsProjector.project(event, read);
      },
    };
    const engine = createProjectionEngine({
      engine: h.engine,
      journal: h.journal,
      projectors: [venomous, recentlyClosedProjector],
      onDelta: (f) => h.frames.push(f),
    });
    const applied = await engine.apply([
      formedEnv(1, 1, [1]),
      renamedEnv(2, 1, 'venom-name'),
      closedEnv(3, 2, 1),
    ]);
    if (!applied.ok) throw new Error('apply failed');
    expect(applied.value.dirtied).toEqual(['missions']);
    const status = await engine.status();
    if (!status.ok) throw new Error('status failed');
    expect(status.value.views.find((v) => v.view === 'missions')?.dirty).toBe(true);
    // Peer view unaffected:
    expect((await storeSnapshot(h, 'recently_closed')).length).toBe(1);
    // Dirty view wm frozen before the venom event; rename never projected:
    const m1 = missionRow(await storeSnapshot(h, 'missions'), missionId(1));
    expect(m1?.['name']).toBe('mission-1');
    // Rebuild recovers: dirty cleared, models recomputed from the journal.
    await seedJournal(h, [
      formedEnv(1, 1, [1]),
      renamedEnv(2, 1, 'venom-name'),
      closedEnv(3, 2, 1),
    ]);
    const rebuilt = await h.projections.rebuild('missions');
    if (!rebuilt.ok) throw new Error('rebuild failed');
    const status2 = await h.projections.status();
    if (!status2.ok) throw new Error('status 2 failed');
    expect(status2.value.views.find((v) => v.view === 'missions')?.dirty).toBe(false);
    const recovered = missionRow(await storeSnapshot(h, 'missions'), missionId(1));
    expect(recovered?.['name']).toBe('venom-name');
    await h.engine.close();
  });

  it('resume-after-kill: a fresh engine instance over the same store resumes from the watermark', async () => {
    const h = await makeProjections();
    await h.projections.apply([formedEnv(1, 1, [1]), renamedEnv(2, 1, 'half-way')]);
    // ☠ instance death (SW recycle). Fresh engine over the SAME storage continues.
    const second = createProjectionEngine({
      engine: h.engine,
      journal: h.journal,
      projectors: [missionsProjector, recentlyClosedProjector],
      onDelta: (f) => h.frames.push(f),
    });
    const resumed = await second.apply([renamedEnv(2, 1, 'half-way'), assignedEnv(3, 2, 1)]);
    if (!resumed.ok) throw new Error('resume failed');
    expect(resumed.value.skippedBelowWatermark).toBeGreaterThan(0);
    const m1 = missionRow(await storeSnapshot(h, 'missions'), missionId(1));
    expect(m1?.['tabIds']).toEqual([tabId(1), tabId(2)]);
    await h.engine.close();
  });

  it('rebuild on a fixed journal reproduces the same models (disposable law)', async () => {
    const h = await makeProjections();
    await seedJournal(h, [
      formedEnv(1, 1, [1, 2]),
      renamedEnv(2, 1, 'archive-me'),
      closedEnv(3, 9, 1),
    ]);
    const applied = await h.projections.applyFromJournal(DEV_A);
    if (!applied.ok) throw new Error('applyFromJournal failed');
    const before = {
      missions: await storeSnapshot(h, 'missions'),
      rc: await storeSnapshot(h, 'recently_closed'),
    };
    const rebuilt = await h.projections.rebuild('missions');
    if (!rebuilt.ok) throw new Error('rebuild failed');
    const rebuiltRc = await h.projections.rebuild('recentlyClosed');
    if (!rebuiltRc.ok) throw new Error('rebuild rc failed');
    expect(await storeSnapshot(h, 'missions')).toEqual(before.missions);
    expect(await storeSnapshot(h, 'recently_closed')).toEqual(before.rc);
    await h.engine.close();
  });
});
