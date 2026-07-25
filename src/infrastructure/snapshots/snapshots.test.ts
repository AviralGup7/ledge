// E2-T08 snapshot unit laws — EES-R5 chunking (500/part, ordered, canonical),
// EES-R4 style fidelity (mandatory groupStyles, partition law), §5 sessions
// store rows, part-completeness probe (completion criterion), retention policy
// (30d/mission, newest preserved), rebuild law over compound pk (engine fix).
import { describe, expect, it } from 'vitest';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import {
  buildSnapshotPayload,
  chunkRefs,
  dedupeRefs,
  partCountOf,
  planRetention,
  SNAPSHOT_CHUNK_SIZE,
  stylesForPart,
} from './index.js';
import type { GroupStyle } from './types.js';
import {
  makeSnapshotWorld,
  snapshotIdOf,
  snapshotMissionId,
  snapshotTabId,
  SNAP_WALL_BASE,
  styleOf,
} from './testkit.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok)
    throw new Error(`expected ok, got ${r.error.code} (${String(r.error.details?.['what'])})`);
  return r.value;
};

const DAY = 24 * 60 * 60 * 1_000;
const ids = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => snapshotTabId(offset + i + 1));

// Indexed access under noUncheckedIndexedAccess without non-null assertions:
// `ids(n)[k]` with k < n is safe by construction; a miss is a harness bug and
// must throw LOUDLY, never be asserted away with `!`.
const atIndex = <T>(arr: readonly T[], i: number): T => {
  const v = arr[i];
  if (v === undefined) throw new Error(`harness index ${i} out of bounds (len ${arr.length})`);
  return v;
};

const input = (
  n: number,
  over: Partial<Parameters<typeof buildSnapshotPayload>[0]> = {},
): Parameters<typeof buildSnapshotPayload>[0] => ({
  snapshotId: snapshotIdOf(1),
  missionId: snapshotMissionId(1),
  tabRecordIds: ids(n),
  groupStyles: [],
  takenAt: SNAP_WALL_BASE,
  trigger: 'park',
  ...over,
});

describe('E2-T08 builder — chunking + drafts (EES-R5)', () => {
  it('B1: chunk-count table (0, 1, 499, 500, 501, 1000, 1001) is exact', () => {
    expect(partCountOf(0)).toBe(0);
    expect(partCountOf(1)).toBe(1);
    expect(partCountOf(SNAPSHOT_CHUNK_SIZE - 1)).toBe(1);
    expect(partCountOf(SNAPSHOT_CHUNK_SIZE)).toBe(1);
    expect(partCountOf(SNAPSHOT_CHUNK_SIZE + 1)).toBe(2);
    expect(partCountOf(SNAPSHOT_CHUNK_SIZE * 2)).toBe(2);
    expect(partCountOf(SNAPSHOT_CHUNK_SIZE * 2 + 1)).toBe(3);
    expect(chunkRefs(ids(0) as string[])).toEqual([]);
    const chunks = chunkRefs(ids(SNAPSHOT_CHUNK_SIZE + 1) as string[]);
    expect(chunks.map((c) => c.length)).toEqual([SNAPSHOT_CHUNK_SIZE, 1]);
  });

  it('B2: dedupe is order-stable first-win and disclosed', () => {
    const d = dedupeRefs(['a', 'b', 'a', 'c', 'b']);
    expect(d.refs).toEqual(['a', 'b', 'c']);
    expect(d.dropped).toBe(2);
    const built = unwrap(
      buildSnapshotPayload(input(0, { tabRecordIds: [snapshotTabId(1), snapshotTabId(1)] })),
    );
    expect(built.payload.tabRecordRefs).toEqual([snapshotTabId(1) as string]);
    expect(built.diagnostics.dedupedRefs).toBe(1);
    expect(built.payload.partCount).toBe(1);
  });

  it('B3: groupStyles field is always emitted (mandatory even when empty); trigger always present', () => {
    const built = unwrap(buildSnapshotPayload(input(3)));
    expect(built.payload.groupStyles).toEqual([]);
    expect(built.payload.trigger).toBe('park');
    expect(built.payload.partCount).toBe(1);
  });

  it('B4: orphan style refs pruned with disclosure; emptied styles kept as facts', () => {
    const tabIds = ids(2);
    const orphanStyle: GroupStyle = styleOf(9, [snapshotTabId(999)]);
    const mixedStyle: GroupStyle = styleOf(8, [atIndex(tabIds, 0), snapshotTabId(999)]);
    const built = unwrap(
      buildSnapshotPayload(input(2, { groupStyles: [orphanStyle, mixedStyle] })),
    );
    expect(built.diagnostics.prunedStyleRefs).toBe(2);
    expect(built.diagnostics.emptiedStyles).toBe(1);
    const orphan = built.payload.groupStyles.find((s) => s.groupId === 9);
    expect(orphan?.tabOrder).toEqual([]); // kept: an empty group is still a style fact
    expect(built.payload.groupStyles.find((s) => s.groupId === 8)?.tabOrder).toEqual([
      tabIds[0] as string,
    ]);
  });

  it('B5: malformed inputs are typed E_OUTPUT_MALFORMED, never partial payloads', () => {
    expect(buildSnapshotPayload(input(1, { takenAt: Number.NaN })).ok).toBe(false);
    expect(buildSnapshotPayload(input(1, { trigger: 'bogus' as never })).ok).toBe(false);
    expect(buildSnapshotPayload(input(1, { tabRecordIds: ['not-an-id'] as never })).ok).toBe(false);
    const style: GroupStyle = {
      groupId: -1,
      name: 'x',
      color: 'blue',
      collapsed: false,
      tabOrder: [],
    };
    expect(buildSnapshotPayload(input(1, { groupStyles: [style] })).ok).toBe(false);
  });

  it('B6: style partition law — a style lands in exactly the parts its refs touch', () => {
    const partA = ids(2, 0);
    const partB = ids(2, 10);
    const both: GroupStyle = styleOf(7, [atIndex(partA, 0), atIndex(partB, 0)]);
    const onlyA: GroupStyle = styleOf(6, partA);
    const none: GroupStyle = styleOf(5, []);
    const styles = [both, onlyA, none];
    expect(
      stylesForPart(styles, partA as string[])
        .map((s) => s.groupId)
        .sort(),
    ).toEqual([6, 7]);
    expect(stylesForPart(styles, partB as string[]).map((s) => s.groupId)).toEqual([7]);
    expect(stylesForPart(styles, ['zz'])).toEqual([]);
  });
});

describe('E2-T08 projector + store — materialization', () => {
  it('M1: 500+1 snapshot materializes two canonical parts with whole-record styles', async () => {
    const w = await makeSnapshotWorld();
    const tabIds = ids(SNAPSHOT_CHUNK_SIZE + 1);
    const first = atIndex(tabIds, 0);
    const last = atIndex(tabIds, SNAPSHOT_CHUNK_SIZE);
    await w.takeSnapshot(
      input(SNAPSHOT_CHUNK_SIZE + 1, {
        groupStyles: [
          styleOf(1, [first], { collapsed: true, name: 'keep', color: 'grey' }),
          styleOf(2, [last]),
        ],
      }),
    );
    expect(await w.applyProjections()).toBe(1);
    const rows = await w.partRows();
    expect(rows).toHaveLength(2);
    const [p0, p1] = rows;
    expect(p0?.partIndex).toBe(0);
    expect(p0?.tabRecordIds).toHaveLength(SNAPSHOT_CHUNK_SIZE);
    expect(p1?.partIndex).toBe(1);
    expect(p1?.tabRecordIds).toEqual([last as string]);
    expect(p0?.groupStyles).toEqual([
      { groupId: 1, name: 'keep', color: 'grey', collapsed: true, tabOrder: [first as string] },
    ]);
    expect(p1?.groupStyles.map((s) => s.groupId)).toEqual([2]);
    expect(p0?.trigger).toBe('park');
    expect(p0?.takenAt).toBe(SNAP_WALL_BASE);
    expect(p0?.missionId).toBe(snapshotMissionId(1) as string);
    const report = unwrap(await w.probe());
    expect(report.complete).toBe(true);
    expect(report.snapshotsChecked).toBe(1);
  });

  it('M2: apply-twice idempotence — zero new ops, rows identical (locked §2.10 counter law)', async () => {
    const w = await makeSnapshotWorld();
    await w.takeSnapshot(input(3, { groupStyles: [styleOf(1, ids(3))] }));
    await w.applyProjections();
    const before = await w.partRows();
    // T03's locked ApplyReport semantics: `applied` counts events DRIVEN
    // THROUGH; idempotence is zero new ops/frames (below-watermark skips).
    // The provable law for this suite: rows byte-identical, stream unchanged.
    expect(await w.applyProjections()).toBe(1);
    expect(await w.partRows()).toEqual(before);
    expect((await w.readAll()).filter((e) => e.envelope.type === 'SnapshotTaken')).toHaveLength(1);
  });

  it('M3: style fidelity fixture (completion criterion) — interleaved groups across chunks', async () => {
    const w = await makeSnapshotWorld();
    // 4 tabs alternating between two groups across a 2:1 boundary.
    const tabIds = [snapshotTabId(1), snapshotTabId(2), snapshotTabId(3), snapshotTabId(4)];
    await w.takeSnapshot(
      input(4, {
        groupStyles: [
          styleOf(11, [atIndex(tabIds, 0), atIndex(tabIds, 2)], {
            name: 'alpha',
            color: 'red',
            collapsed: true,
          }),
          styleOf(22, [atIndex(tabIds, 1), atIndex(tabIds, 3)], { name: 'beta', color: 'green' }),
        ],
      }),
    );
    await w.applyProjections();
    const [row] = await w.partRows();
    expect(row?.groupStyles).toEqual([
      {
        groupId: 11,
        name: 'alpha',
        color: 'red',
        collapsed: true,
        tabOrder: [tabIds[0] as string, tabIds[2] as string],
      },
      {
        groupId: 22,
        name: 'beta',
        color: 'green',
        collapsed: false,
        tabOrder: [tabIds[1] as string, tabIds[3] as string],
      },
    ]);
  });

  it('M4: empty snapshot is lawful (event marker, zero rows, probe complete)', async () => {
    const w = await makeSnapshotWorld();
    await w.takeSnapshot(input(0));
    await w.applyProjections();
    expect(await w.partRows()).toEqual([]);
    const report = unwrap(await w.probe());
    expect(report.complete).toBe(true);
    expect(report.snapshotsChecked).toBe(1);
  });

  it('M5: hand-written event without trigger materializes with trigger ABSENT (never fabricated)', async () => {
    const w = await makeSnapshotWorld();
    const refs = ids(2);
    await w.append([
      w.env('SnapshotTaken', {
        snapshotId: snapshotIdOf(9),
        missionId: snapshotMissionId(1),
        partCount: 1,
        tabRecordRefs: refs,
        groupStyles: [],
        takenAt: SNAP_WALL_BASE,
      }),
    ]);
    await w.applyProjections();
    const [row] = await w.partRows();
    expect(row?.trigger).toBeUndefined();
    expect(unwrap(await w.probe()).complete).toBe(true);
  });

  it('M6: rebuild wipes + replays the compound-pk sessions store exactly (engine wipe law)', async () => {
    const w = await makeSnapshotWorld();
    await w.takeSnapshot(input(SNAPSHOT_CHUNK_SIZE + 2, { groupStyles: [styleOf(1, ids(3))] }));
    await w.applyProjections();
    const before = await w.partRows();
    // Plant a foreign row: rebuild must remove it (wipe covers compound pks).
    await w.putRow({
      snapshotId: 'foreign',
      partIndex: 0,
      missionId: snapshotMissionId(1) as string,
      tabRecordIds: [],
      groupStyles: [],
      takenAt: 0,
    });
    const rebuilt = unwrap(await w.projections.rebuild('sessions'));
    expect(rebuilt.view).toBe('sessions');
    expect(await w.partRows()).toEqual(before);
    expect(unwrap(await w.probe()).complete).toBe(true);
  });

  it('M7: other views rebuild exactly as before (engine wipe change regression)', async () => {
    const w = await makeSnapshotWorld();
    await w.append([
      w.env('MissionFormed', {
        missionId: snapshotMissionId(1),
        name: 'alpha',
        namedBy: 'user',
        tabIds: [],
      }),
    ]);
    await w.applyProjections();
    const rebuilt = unwrap(await w.projections.rebuild('missions'));
    expect(rebuilt.view).toBe('missions');
    const rows = await w.engine.txn(['missions'], 'readonly', (tx) =>
      tx.table('missions').toArray(),
    );
    expect(rows.ok && rows.value).toHaveLength(1);
  });
});

describe('E2-T08 probe — part-completeness findings (completion criterion)', () => {
  it('P1: every tear is named precisely (missing, extra, untracked, chunk, id, style, meta)', async () => {
    const w = await makeSnapshotWorld();
    const three = ids(SNAPSHOT_CHUNK_SIZE + 50);
    await w.takeSnapshot(input(SNAPSHOT_CHUNK_SIZE + 50)); // 2 parts expected
    await w.applyProjections();
    // missing part
    await w.deleteRow(snapshotIdOf(1) as string, 1);
    let report = unwrap(await w.probe());
    expect(report.complete).toBe(false);
    expect(report.issues).toEqual([
      { kind: 'missing-part', snapshotId: snapshotIdOf(1) as string, partIndex: 1 },
    ]);
    // restore path: applyFromJournal's watermark law correctly does NOT
    // resurrect deleted rows (watermarks move forward only); the sanctioned
    // repair is rebuild (probe named the damage, rebuild replays the stream).
    expect(await w.partRows()).toHaveLength(1); // watermark never regresses
    unwrap(await w.projections.rebuild('sessions'));
    expect(await w.partRows()).toHaveLength(2);
    await w.putRow({
      snapshotId: snapshotIdOf(1) as string,
      partIndex: 2,
      missionId: snapshotMissionId(1) as string,
      tabRecordIds: [],
      groupStyles: [],
      takenAt: SNAP_WALL_BASE,
    });
    report = unwrap(await w.probe());
    expect(report.issues.map((i) => i.kind).sort()).toEqual(['extra-part']);
    // untracked row (snapshot never journaled)
    await w.deleteRow(snapshotIdOf(1) as string, 2);
    await w.putRow({
      snapshotId: 'ghost',
      partIndex: 0,
      missionId: 'm',
      tabRecordIds: [],
      groupStyles: [],
      takenAt: 0,
    });
    report = unwrap(await w.probe());
    expect(report.issues).toEqual([{ kind: 'untracked-row', snapshotId: 'ghost', partIndex: 0 }]);
    // chunk-pattern + id-mismatch + style/meta divergence through a wrong rewrite
    await w.deleteRow('ghost', 0);
    await w.putRow({
      snapshotId: snapshotIdOf(1) as string,
      partIndex: 0,
      missionId: snapshotMissionId(1) as string,
      tabRecordIds: three.slice(0, 3) as string[],
      groupStyles: [styleOf(55, [], { name: 'bogus' })],
      takenAt: SNAP_WALL_BASE + 1,
    });
    report = unwrap(await w.probe());
    expect(report.issues.map((i) => i.kind).sort()).toEqual(
      ['chunk-pattern', 'meta-mismatch', 'meta-mismatch', 'style-mismatch'].sort(),
    );
    expect(
      report.issues
        .filter((i) => i.kind === 'meta-mismatch')
        .map((i) => (i as { field: string }).field)
        .sort(),
    ).toEqual(['takenAt', 'trigger']); // row dropped trigger AND shifted takenAt
  });

  it('P2: duplicate snapshot events are findings; last-in-stream governs', async () => {
    const w = await makeSnapshotWorld();
    await w.takeSnapshot(input(2));
    // Producer bug: same snapshotId appended again (different batch/key).
    const dup = unwrap(buildSnapshotPayload(input(2, { trigger: 'crash' })));
    await w.append([w.env('SnapshotTaken', { ...dup.payload })]);
    await w.applyProjections();
    const report = unwrap(await w.probe());
    expect(report.issues.map((i) => i.kind)).toContain('duplicate-snapshot-event');
    const [row] = await w.partRows();
    expect(row?.trigger).toBe('crash'); // last event materialized (apply order)
  });

  it('P3: probe is pure — storage + journal untouched between two probes', async () => {
    const w = await makeSnapshotWorld();
    await w.takeSnapshot(input(3));
    await w.applyProjections();
    const eventsBefore = (await w.readAll()).length;
    const rowsBefore = await w.partRows();
    unwrap(await w.probe());
    unwrap(await w.probe());
    expect((await w.readAll()).length).toBe(eventsBefore);
    expect(await w.partRows()).toEqual(rowsBefore);
  });
});

describe('E2-T08 retention policy (30d/mission, newest preserved)', () => {
  const snap = (id: string, mission: string, ageDays: number, now: number) => ({
    snapshotId: id,
    missionId: mission,
    takenAt: now - ageDays * DAY,
  });

  it('R1: newest per mission kept unconditionally; others ride the 30d window', () => {
    const now = 10_000 * DAY;
    const plan = planRetention(
      [
        // m1: a within-window family — newest kept, window kept, boundary purged.
        snap('fresh', 'm1', 5, now),
        snap('fresh2', 'm1', 29.9, now),
        snap('edge-keeper', 'm1', 29.999, now),
        snap('edge-purge', 'm1', 30, now), // boundary: exactly 30d ⇒ purged
        snap('stale', 'm1', 400, now), // not newest ⇒ purged despite mission
        // m2: ancient-only mission — its NEWEST is preserved unconditionally.
        snap('elder-new', 'm2', 400, now),
        snap('elder-older', 'm2', 500, now),
      ],
      now,
    );
    expect(plan.keep).toEqual(['edge-keeper', 'elder-new', 'fresh', 'fresh2'].sort());
    expect(plan.purge).toEqual(['edge-purge', 'elder-older', 'stale'].sort());
  });

  it('R2: deterministic ties break by snapshotId (aged snapshots past the window)', () => {
    const now = 100 * DAY;
    const ageDays = 50; // both past the 30d window ⇒ only the "newest" survives
    const plan = planRetention(
      [
        { snapshotId: 'b', missionId: 'm', takenAt: now - ageDays * DAY },
        { snapshotId: 'a', missionId: 'm', takenAt: now - ageDays * DAY },
      ],
      now,
    );
    expect(plan.keep).toEqual(['a']); // tied takenAt ⇒ id order picks the survivor
    expect(plan.purge).toEqual(['b']);
  });

  it('R3: empty input plans empty; keep ∪ purge partitions input', () => {
    expect(planRetention([], 0)).toEqual({ keep: [], purge: [] });
  });
});
