// E3-APP · Domain legality invariant matrix (EES §2.5 invariants i/ii/iii + contract
// transition rules C9–C18 + §10-R13). Deciders are pure: same inputs ⇒ same decision.
import { describe, expect, it } from 'vitest';
import {
  decideArchive,
  decideConclude,
  decideEmptyTrash,
  decideMerge,
  decideMove,
  decideParkPlan,
  decidePurgeSubject,
  decideRename,
  decideSplit,
  decideTrash,
  decideTrashRestore,
  decideUndo,
} from './transitions.js';
import { DEFAULT_LIFECYCLE_POLICY, policyOf, trashRetentionMsOf } from './policies/retention.js';

const BULK = DEFAULT_LIFECYCLE_POLICY.bulkConfirmThreshold;

describe('invariant (i) — snapshot plan precedes intent acceptance', () => {
  it('park plan without snapshotRef refuses; with it, accepts intent events', () => {
    const bad = decideParkPlan({
      tabIds: ['t1'],
      groupStyles: [],
      snapshotId: undefined,
      issuedAt: 1,
    });
    expect(bad.allowed).toBe(false);
    const good = decideParkPlan({
      tabIds: ['t1', 't2'],
      groupStyles: [],
      snapshotId: 's1',
      issuedAt: 1,
    });
    expect(good.allowed).toBe(true);
    if (good.allowed) {
      expect(good.events[0]?.type).toBe('ParkIntentAccepted');
      expect(JSON.stringify(good.events[0]?.payload)).toContain('s1');
    }
  });
  it('empty park scope refuses', () => {
    const d = decideParkPlan({ tabIds: [], groupStyles: [], snapshotId: 's1', issuedAt: 1 });
    expect(d.allowed).toBe(false);
  });
});

describe('invariant (ii) — system deletion of KEPT content is unreachable', () => {
  it('purge decider refuses every non-trash state (no code path exists)', () => {
    for (const state of ['live', 'kept', 'parked', 'archived', 'unknown']) {
      const d = decidePurgeSubject(state);
      expect(d.allowed).toBe(false);
    }
    expect(decidePurgeSubject('trash').allowed).toBe(true);
  });
  it('empty-trash composes purge only over the trash set and requires exact confirm', () => {
    expect(decideEmptyTrash({ confirm: 'yes', trashEntryCount: 3, now: 7 }).allowed).toBe(false);
    expect(decideEmptyTrash({ confirm: true, trashEntryCount: 0, now: 7 }).allowed).toBe(false);
    const ok = decideEmptyTrash({ confirm: true, trashEntryCount: 3, now: 7 });
    expect(ok.allowed).toBe(true);
    if (ok.allowed) expect(ok.events[0]?.type).toBe('TrashPurged');
  });
});

describe('invariant (iii) — destructive decisions carry inverse atoms', () => {
  it('trash embeds the restore atom (tab and mission)', () => {
    const t = decideTrash({
      kind: 'tab',
      id: 't1',
      state: 'kept',
      parentMissionId: 'm1',
      bulkThreshold: BULK,
      now: 1,
    });
    expect(t.allowed && t.inverseAtom?.kind).toBe('restore-tab');
    const m = decideTrash({
      kind: 'mission',
      id: 'm1',
      state: 'archived',
      bulkThreshold: BULK,
      now: 1,
    });
    expect(m.allowed && m.inverseAtom?.kind).toBe('restore-mission');
  });
  it('merge carries split-back atom; split carries merge-back atom', () => {
    const merge = decideMerge('a', 'b', ['t1'], 'live', 'archived');
    expect(merge.allowed && merge.inverseAtom?.kind).toBe('split-merged');
    const split = decideSplit('m-new', ['t1'], ['t1', 't2'], undefined, 'user');
    expect(split.allowed && split.inverseAtom?.kind).toBe('merge-back');
  });
});

describe('transition laws (contract validation highlights)', () => {
  it('rename trims/collapses and refuses blank', () => {
    expect(decideRename('m1', '   ', 'user').allowed).toBe(false);
    const d = decideRename('m1', '  Deep   Work  ', 'user');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.events[0]?.payload).toMatchObject({ name: 'Deep Work' });
  });
  it('merge refuses self-merge and trash involvement', () => {
    expect(decideMerge('a', 'a', [], 'live', 'live').allowed).toBe(false);
    expect(decideMerge('a', 'b', [], 'trash', 'live').allowed).toBe(false);
  });
  it('merge composes TabMoved-per-tab (§4 singular) plus MissionArchived container close', () => {
    const d = decideMerge('a', 'b', ['t1', 't2'], 'live', 'archived');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.events.map((e) => e.type)).toEqual(['TabMoved', 'TabMoved', 'MissionArchived']);
      expect(d.events[0]?.payload).toMatchObject({
        tabId: 't1',
        missionId: 'b',
        fromMissionId: 'a',
      });
      expect(d.events[2]?.payload).toMatchObject({ missionId: 'a', mergedInto: 'b' });
    }
  });
  it('split requires a minted id and a non-empty subset of source membership', () => {
    expect(decideSplit('', ['t1'], ['t1'], undefined, 'user').allowed).toBe(false);
    expect(decideSplit('m-new', [], ['t1'], undefined, 'user').allowed).toBe(false);
    expect(decideSplit('m-new', ['t9'], ['t1', 't2'], undefined, 'user').allowed).toBe(false);
    const ok = decideSplit('m-new', ['t1'], ['t1', 't2'], 'Focus', 'user');
    expect(ok.allowed).toBe(true);
    if (ok.allowed) {
      expect(ok.events[0]?.type).toBe('MissionFormed');
      expect(ok.events[0]?.payload).toMatchObject({
        missionId: 'm-new',
        name: 'Focus',
        namedBy: 'user',
      });
      expect(ok.events[1]?.type).toBe('TabMoved');
    }
  });
  it('archive refuses trash; conclude implies archived and requires parked/archived', () => {
    expect(decideArchive('m1', 'trash').allowed).toBe(false);
    expect(decideConclude('m1', 'live', undefined).allowed).toBe(false);
    const c = decideConclude('m1', 'archived', ' shipped it ');
    expect(c.allowed).toBe(true);
    if (c.allowed) {
      expect(c.events.map((e) => e.type)).toEqual(['MissionConcluded', 'MissionArchived']);
      expect(c.events[0]?.payload).toMatchObject({ outcomeNote: 'shipped it' });
    }
  });
  it('move requires KEPT-or-LIVE tabs and a non-trash destination', () => {
    const base = { tabIds: ['t1'], toMissionId: 'm2', tabStates: { t1: 'kept' } };
    expect(
      decideMove({ ...base, destinationState: 'trash', tabSources: { t1: 'm1' } }).allowed,
    ).toBe(false);
    expect(
      decideMove({
        ...base,
        destinationState: 'live',
        tabStates: { t1: 'trash' },
        tabSources: { t1: 'm1' },
      }).allowed,
    ).toBe(false);
    const ok = decideMove({ ...base, destinationState: 'parked', tabSources: { t1: 'm1' } });
    expect(ok.allowed).toBe(true);
  });
  it('move sequences fromMissionId per §4 (omitted when source equals destination)', () => {
    const d = decideMove({
      tabIds: ['t1', 't2'],
      toMissionId: 'm2',
      destinationState: 'live',
      tabStates: { t1: 'live', t2: 'kept' },
      tabSources: { t1: 'm1', t2: 'm2' },
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.events[0]?.payload).toMatchObject({
        tabId: 't1',
        missionId: 'm2',
        fromMissionId: 'm1',
      });
      expect(d.events[1]?.payload).toMatchObject({ tabId: 't2', missionId: 'm2' });
      expect(JSON.stringify(d.events[1]?.payload)).not.toContain('fromMissionId');
    }
  });
});

describe('trash + restore law (C15/C16/C17 + §10-R13)', () => {
  it('bulk confirm threshold gates large deletes', () => {
    const d = decideTrash({
      kind: 'mission',
      id: 'm1',
      state: 'live',
      bulkSize: BULK + 1,
      confirmedLarge: false,
      bulkThreshold: BULK,
      now: 1,
    });
    expect(d.allowed).toBe(false);
    const ok = decideTrash({
      kind: 'mission',
      id: 'm1',
      state: 'live',
      bulkSize: BULK + 1,
      confirmedLarge: true,
      bulkThreshold: BULK,
      now: 1,
    });
    expect(ok.allowed).toBe(true);
  });
  it('restore window expires at retention; parent-dead restore re-creates minimal mission (R13)', () => {
    const retention = trashRetentionMsOf(DEFAULT_LIFECYCLE_POLICY);
    const expired = decideTrashRestore({
      kind: 'tab',
      id: 't1',
      state: 'trash',
      parentMissionId: 'm1',
      parentState: undefined,
      resolvedMissionId: 'm-resolved',
      deletedAt: 0,
      now: retention + 1,
      trashRetentionMs: retention,
    });
    expect(expired.allowed).toBe(false);
    const live = decideTrashRestore({
      kind: 'tab',
      id: 't1',
      state: 'trash',
      parentMissionId: 'm1',
      parentState: 'trash',
      resolvedMissionId: 'm-resolved',
      deletedAt: 0,
      now: 1_000,
      trashRetentionMs: retention,
      domainName: 'example.com',
    });
    expect(live.allowed).toBe(true);
    if (live.allowed) {
      expect(live.events[0]?.type).toBe('MissionFormed');
      expect(live.events[0]?.payload).toMatchObject({
        missionId: 'm-resolved',
        name: 'example.com',
        namedBy: 'system',
      });
      expect(live.events[1]?.type).toBe('TrashRestored');
      expect(live.events[1]?.payload).toMatchObject({ resolvedMissionId: 'm-resolved' });
    }
  });
  it('restore with a LIVE parent emits no parent re-creation (R13 dead-parent only)', () => {
    const retention = trashRetentionMsOf(DEFAULT_LIFECYCLE_POLICY);
    const d = decideTrashRestore({
      kind: 'tab',
      id: 't1',
      state: 'trash',
      parentMissionId: 'm1',
      parentState: 'live',
      resolvedMissionId: 'm1',
      deletedAt: 0,
      now: 1_000,
      trashRetentionMs: retention,
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.events).toHaveLength(1);
      expect(d.events[0]?.type).toBe('TrashRestored');
    }
  });
});

describe('undo law + policy reader', () => {
  it('undo refuses an empty stack and emits no novel events', () => {
    expect(decideUndo(0).allowed).toBe(false);
    const d = decideUndo(3);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.events).toHaveLength(0);
  });
  it('policyOf applies settings overrides with defaults intact (P-08 same input ⇒ same out)', () => {
    const p = policyOf([{ key: 'trash.retentionDays', value: 90 }]);
    expect(p.trashDays).toBe(90);
    expect(p.undoStackCap).toBe(DEFAULT_LIFECYCLE_POLICY.undoStackCap);
    const again = policyOf([{ key: 'trash.retentionDays', value: 90 }]);
    expect(JSON.stringify(again)).toBe(JSON.stringify(p));
    expect(policyOf(undefined)).toBe(DEFAULT_LIFECYCLE_POLICY);
  });
});
