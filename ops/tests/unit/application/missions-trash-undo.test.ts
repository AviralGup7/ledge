// E3-APP · Mission lifecycle + trash + universal-undo service contract (Spec §5.12,
// EES §2.5 legality-in-domain, C11–C18). Locking laws: every mutation carries its
// inverse atom (universal undo); trash cascades materialize bulkId-linked entries;
// restore honors §10-R13 dead-parent re-creation + C16 retention; undo pops atoms as
// their own §4 events (no novel undo events); redo is an honest v1 refusal.
import { describe, expect, it } from 'vitest';
import {
  ledgeTabIdOf,
  liveTabPlan,
  makeServices,
  mustOk,
  testId,
  type SeedPlan,
  type ServicesHarness,
} from './services.testkit.js';

const missionIdOf = (n: number): string => testId(40_000 + n);
const DOMAIN_REASON = 'E_DOMAIN_LEGALITY';
const RETENTION_MS = 2_592_000_000; // 30d (DEFAULT_LIFECYCLE_POLICY.trashDays)

const missionPlan = (m: number, name: string, tabNums: readonly number[]): SeedPlan => ({
  type: 'MissionFormed',
  payload: {
    missionId: missionIdOf(m),
    name,
    namedBy: 'user',
    tabIds: tabNums.map(ledgeTabIdOf),
  },
});

const undoStack = async (h: ServicesHarness) => {
  const row = await h.row('meta', 'undoStack');
  return (Array.isArray(row?.['value']) ? row['value'] : []) as readonly {
    readonly kind: string;
    readonly label: string;
  }[];
};

const eventPayloadOf = async <T>(
  h: ServicesHarness,
  type: string,
  index = 0,
): Promise<T | undefined> =>
  (await h.events()).filter((e) => e.type === type).map((e) => e.payload as T)[index];

describe('E3-APP missions — lifecycle legality + inverse atoms', () => {
  it('rename stamps MissionRenamed, returns previousName material, and pushes the atom', async () => {
    const h = await makeServices();
    await h.seed([missionPlan(1, 'old-name', [])]);
    const out = await mustOk(
      h.services.missions.rename(
        { missionId: missionIdOf(1), name: '  new-name  ' },
        h.ctxOf(1).ctx,
      ),
    );
    expect(out.oldName).toBe('old-name');
    const row = await h.row('missions', missionIdOf(1));
    expect(row?.['name']).toBe('new-name'); // trimmed by the domain
    const stack = await undoStack(h);
    expect(stack.length).toBe(1);
    expect(stack[0]?.kind).toBe('rename-mission');

    const missing = await h.services.missions.rename(
      { missionId: missionIdOf(99), name: 'x' },
      h.ctxOf(2).ctx,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe(DOMAIN_REASON);

    const blank = await h.services.missions.rename(
      { missionId: missionIdOf(1), name: '   ' },
      h.ctxOf(3).ctx,
    );
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe(DOMAIN_REASON);
  });

  it('merge archives the source (§4-pure), unions membership, and pushes split-merged', async () => {
    const h = await makeServices();
    await h.seed([
      liveTabPlan(1),
      liveTabPlan(2),
      missionPlan(1, 'a', [1]),
      missionPlan(2, 'b', [2]),
    ]);
    const out = await mustOk(
      h.services.missions.merge({ fromId: missionIdOf(1), intoId: missionIdOf(2) }, h.ctxOf(4).ctx),
    );
    expect(out.intoId).toBe(missionIdOf(2));
    const target = await h.row('missions', missionIdOf(2));
    expect([...(target?.['tabIds'] as readonly string[])].sort()).toEqual(
      [ledgeTabIdOf(1), ledgeTabIdOf(2)].sort(),
    );
    const source = await h.row('missions', missionIdOf(1));
    expect(source?.['state']).toBe('archived');
    expect((await undoStack(h))[0]?.kind).toBe('split-merged');

    const reflexive = await h.services.missions.merge(
      { fromId: missionIdOf(2), intoId: missionIdOf(2) },
      h.ctxOf(5).ctx,
    );
    expect(reflexive.ok).toBe(false);
    if (reflexive.ok) return;
    expect(reflexive.error.code).toBe(DOMAIN_REASON);
  });

  it('split forms a new mission with the selection; the source keeps the remainder', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), liveTabPlan(2), missionPlan(1, 'whole', [1, 2])]);
    const out = await mustOk(
      h.services.missions.split({ tabIds: [ledgeTabIdOf(2)], newName: 'half' }, h.ctxOf(6).ctx),
    );
    const fresh = await h.row('missions', out.newMissionId);
    expect(fresh?.['name']).toBe('half');
    expect(fresh?.['tabIds']).toEqual([ledgeTabIdOf(2)]);
    const source = await h.row('missions', missionIdOf(1));
    expect(source?.['tabIds']).toEqual([ledgeTabIdOf(1)]);
    expect((await undoStack(h))[0]?.kind).toBe('merge-back');

    const emptySel = await h.services.missions.split({ tabIds: [] }, h.ctxOf(7).ctx);
    expect(emptySel.ok).toBe(false);
    if (emptySel.ok) return;
    expect(emptySel.error.code).toBe(DOMAIN_REASON);
  });

  it('moveTabs re-homes only (no state changes); all-missing selection refuses', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), missionPlan(1, 'a', [1]), missionPlan(2, 'b', [])]);
    const out = await mustOk(
      h.services.missions.moveTabs(
        { tabIds: [ledgeTabIdOf(1)], toMissionId: missionIdOf(2) },
        h.ctxOf(8).ctx,
      ),
    );
    expect(out.moved).toBe(1);
    const moved = await h.row('tabs', ledgeTabIdOf(1));
    expect(moved?.['missionId']).toBe(missionIdOf(2));
    expect(moved?.['state']).toBe('live'); // re-homing never flips lifecycle state
    expect((await h.row('missions', missionIdOf(1)))?.['tabIds']).toEqual([]);
    expect((await undoStack(h))[0]?.kind).toBe('move-back');

    const toMissing = await h.services.missions.moveTabs(
      { tabIds: [ledgeTabIdOf(1)], toMissionId: missionIdOf(88) },
      h.ctxOf(9).ctx,
    );
    expect(toMissing.ok).toBe(false);
    if (toMissing.ok) return;
    expect(toMissing.error.code).toBe(DOMAIN_REASON);
  });

  it('conclude requires parked|archived (domain law), implies archived, carries NO atom', async () => {
    const h = await makeServices();
    await h.seed([missionPlan(1, 'done', [])]);
    // Live missions refuse conclude — the domain gate, not a service convenience.
    const live = await h.services.missions.conclude({ missionId: missionIdOf(1) }, h.ctxOf(9).ctx);
    expect(live.ok).toBe(false);
    if (live.ok) return;
    expect(live.error.details?.['reason']).toBe('conclude-requires-parked-or-archived');

    await mustOk(h.services.missions.archive({ missionId: missionIdOf(1) }, h.ctxOf(10).ctx));
    await mustOk(
      h.services.missions.conclude(
        { missionId: missionIdOf(1), outcomeNote: 'shipped' },
        h.ctxOf(11).ctx,
      ),
    );
    const row = await h.row('missions', missionIdOf(1));
    expect(row?.['concluded']).toBe(true);
    expect(row?.['state']).toBe('archived');
    const ev = await eventPayloadOf<Record<string, unknown>>(h, 'MissionConcluded');
    expect(ev?.['outcomeNote']).toBe('shipped');
    // Concluded-flag stickiness is adr-noted: conclude pushes nothing; the stack
    // holds exactly the earlier archive atom.
    const stack = await undoStack(h);
    expect(stack.length).toBe(1);
    expect(stack[0]?.kind).toBe('unarchive');
  });
});

describe('E3-APP trash — cascade, bulk gate, restore, purge (C15–C17, §10-R13)', () => {
  it('mission delete cascades with a shared bulkId and ONE merged restore atom', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), liveTabPlan(2), missionPlan(1, 'bulk', [1, 2])]);
    const out = await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(11).ctx),
    );
    expect(out.trashed).toBe(3); // mission + both member tabs
    const trashed = (await h.events()).filter((e) => e.type === 'EntityTrashed');
    expect(trashed.length).toBe(3);
    const bulkIds = trashed.map((e) => (e.payload as { bulkId?: string }).bulkId);
    expect(new Set(bulkIds.filter((b) => b !== undefined)).size).toBe(1);
    expect((await h.row('missions', missionIdOf(1)))?.['state']).toBe('trash');
    expect((await h.row('tabs', ledgeTabIdOf(1)))?.['state']).toBe('trash');
    const stack = await undoStack(h);
    expect(stack.length).toBe(1);
    expect(stack[0]?.kind).toBe('restore-cascade');
  });

  it('C15: bulkSize above the threshold without confirmedLarge refuses honestly', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), missionPlan(1, 'one', [1])]);
    const refused = await h.services.trash.deleteEntity(
      { kind: 'mission', id: missionIdOf(1), bulkSize: 21 },
      h.ctxOf(12).ctx,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(DOMAIN_REASON);
    expect(refused.error.details?.['reason']).toBe('bulk-confirm-required');

    const confirmed = await mustOk(
      h.services.trash.deleteEntity(
        { kind: 'mission', id: missionIdOf(1), bulkSize: 21, confirmedLarge: true },
        h.ctxOf(13).ctx,
      ),
    );
    expect(confirmed.trashed).toBe(2);
  });

  it('§10-R13: restoring a tab whose parent mission died re-creates a minimal mission', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), liveTabPlan(2), missionPlan(1, 'doomed', [1, 2])]);
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(14).ctx),
    );
    // Restore exactly one tab; its parent stays trash → R13 fires.
    const out = await mustOk(
      h.services.trash.restore({ kind: 'tab', id: ledgeTabIdOf(1) }, h.ctxOf(15).ctx),
    );
    expect(out.missionId).not.toBe(missionIdOf(1));
    const recreated = await h.row('missions', out.missionId);
    expect(recreated?.['namedBy']).toBe('system');
    expect(recreated?.['name']).toBe('site-1.test'); // R13: named from the tab domain
    const tab = await h.row('tabs', ledgeTabIdOf(1));
    expect(tab?.['state']).toBe('kept');
    expect(tab?.['missionId']).toBe(out.missionId);
  });

  it('C16: within-retention restores; expired entries refuse', async () => {
    const h = await makeServices();
    const seeds: SeedPlan[] = [
      liveTabPlan(1),
      liveTabPlan(2),
      missionPlan(1, 'keep-fresh', [1]),
      missionPlan(2, 'keep-stale', [2]),
    ];
    await h.seed(seeds);
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(16).ctx),
    );
    // Age the stale mission's entry past retention by editing its trash row's deletedAt.
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(2) }, h.ctxOf(17).ctx),
    );

    const fresh = await mustOk(
      h.services.trash.restore({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(18).ctx),
    );
    expect(fresh.missionId).toBe(missionIdOf(1));
    expect((await h.row('missions', missionIdOf(1)))?.['state']).not.toBe('trash');

    // Force-clock travel: stamp the stale entry's deletedAt beyond retention.
    const staleRow = await h.row('missions', missionIdOf(2));
    const ancient = Number(staleRow?.['deletedAt'] ?? 0) - RETENTION_MS - 1;
    await h.engine.txn(['missions'], 'readwrite', async (tx) => {
      await tx
        .table('missions')
        .put({ ...(staleRow ?? {}), missionId: missionIdOf(2), deletedAt: ancient });
    });
    const expired = await h.services.trash.restore(
      { kind: 'mission', id: missionIdOf(2) },
      h.ctxOf(19).ctx,
    );
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.error.code).toBe(DOMAIN_REASON);
  });

  it('C17: confirm-exact purge removes entries per-entry with a purge epoch', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), missionPlan(1, 'gone', [1])]);
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(20).ctx),
    );

    const unconfirmed = await h.services.trash.emptyTrash({ confirm: false }, h.ctxOf(21).ctx);
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) return;
    expect(unconfirmed.error.details?.['reason']).toBe('empty-trash-confirm-exact');

    const out = await mustOk(h.services.trash.emptyTrash({ confirm: true }, h.ctxOf(22).ctx));
    expect(out.purged).toBe(2);
    expect(await h.row('missions', missionIdOf(1))).toBeUndefined();
    expect(await h.row('tabs', ledgeTabIdOf(1))).toBeUndefined();
    const purged = (await h.events()).filter((e) => e.type === 'TrashPurged');
    expect(purged.length).toBe(2);
    const epochs = new Set(purged.map((e) => (e.payload as { purgeEpoch: number }).purgeEpoch));
    expect(epochs.size).toBe(1); // one epoch per sweep (deterministic baseline+1)
  });
});

describe('E3-APP undo — §5.12 universal undo over the atom vocabulary', () => {
  it('undo replays the rename inverse as its own §4 event and empties the stack', async () => {
    const h = await makeServices();
    await h.seed([missionPlan(1, 'original', [])]);
    await mustOk(
      h.services.missions.rename({ missionId: missionIdOf(1), name: 'changed' }, h.ctxOf(23).ctx),
    );
    const out = await mustOk(h.services.undo.undo(h.ctxOf(24).ctx));
    expect(out.undid).toBe('msg.undo.renamed'); // §3.2 copy-catalog key
    expect((await h.row('missions', missionIdOf(1)))?.['name']).toBe('original');
    const renames = (await h.events()).filter((e) => e.type === 'MissionRenamed');
    expect(renames.length).toBe(2); // the undo IS a rename (no novel undo events)
    expect((await undoStack(h)).length).toBe(0);

    const empty = await h.services.undo.undo(h.ctxOf(25).ctx);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.details?.['reason']).toBe('undo-empty-stack');
  });

  it('undo unwinds a mission-delete cascade (restore-cascade → all restored)', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), liveTabPlan(2), missionPlan(1, 'victim', [1, 2])]);
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(26).ctx),
    );
    const out = await mustOk(h.services.undo.undo(h.ctxOf(27).ctx));
    expect(out.undid).toBe('msg.undo.trashed-mission'); // cascade rides the mission row's label
    expect((await h.row('missions', missionIdOf(1)))?.['state']).not.toBe('trash');
    expect((await h.row('tabs', ledgeTabIdOf(1)))?.['state']).toBe('kept');
    expect((await h.row('tabs', ledgeTabIdOf(2)))?.['state']).toBe('kept');
  });

  it('redo is the honest v1 refusal (E_CAPABILITY redo-unscoped-v1), never a silent no-op', async () => {
    const h = await makeServices();
    const r = await h.services.undo.redo(h.ctxOf(28).ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_CAPABILITY');
    expect(r.error.details?.['fault']).toBe('redo-unscoped-v1');
  });
});
