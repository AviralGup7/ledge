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
  decideResume,
  decideSplit,
  decideTrash,
  decideTrashRestore,
  decideUndo,
} from './transitions.js';
import type { Decision, PlannedEvent } from './transitions.js';
import { DEFAULT_LIFECYCLE_POLICY, policyOf, trashRetentionMsOf } from './policies/retention.js';
import { isKnownEventType, validatePayload } from '@/shared-kernel/events/validate.js';

const BULK = DEFAULT_LIFECYCLE_POLICY.bulkConfirmThreshold;

describe('invariant (i) — snapshot plan precedes intent acceptance', () => {
  it('park plan without snapshotRef refuses; with it, accepts intent events', () => {
    const bad = decideParkPlan({
      tabIds: ['t1'],
      groupStyles: [],
      snapshotId: undefined,
      intentId: 'i1',
      issuedAt: 1,
    });
    expect(bad.allowed).toBe(false);
    const good = decideParkPlan({
      tabIds: ['t1', 't2'],
      groupStyles: [],
      snapshotId: 's1',
      intentId: 'i1',
      issuedAt: 1,
    });
    expect(good.allowed).toBe(true);
    if (good.allowed) {
      expect(good.events[0]?.type).toBe('ParkIntentAccepted');
      expect(good.events[0]?.payload).toMatchObject({ intentId: 'i1' });
      expect(JSON.stringify(good.events[0]?.payload)).toContain('s1');
    }
  });
  it('empty park scope refuses; idless intent refuses', () => {
    const base = { tabIds: [] as string[], groupStyles: [], snapshotId: 's1', issuedAt: 1 };
    expect(decideParkPlan({ ...base, intentId: 'i1' }).allowed).toBe(false);
    expect(decideParkPlan({ ...base, tabIds: ['t1'], intentId: '' }).allowed).toBe(false);
  });
});

describe('invariant (ii) — system deletion of KEPT content is unreachable', () => {
  it('purge decider refuses every non-trash state (no code path exists)', () => {
    for (const state of ['live', 'kept', 'parked', 'archived', 'unknown']) {
      const d = decidePurgeSubject({
        subject: { kind: 'tab', id: 't1' },
        state,
        purgeEpoch: 3,
        now: 7,
      });
      expect(d.allowed).toBe(false);
    }
    const ok = decidePurgeSubject({
      subject: { kind: 'tab', id: 't1' },
      state: 'trash',
      purgeEpoch: 3,
      now: 7,
    });
    expect(ok.allowed).toBe(true);
    if (ok.allowed)
      expect(ok.events[0]?.payload).toMatchObject({ kind: 'tab', id: 't1', purgeEpoch: 3 });
  });
  it('empty-trash composes one TrashPurged PER ENTRY over the trash set, confirm-exact', () => {
    const entries = [
      { kind: 'tab' as const, id: 't1' },
      { kind: 'mission' as const, id: 'm1' },
    ];
    expect(decideEmptyTrash({ confirm: 'yes', entries, purgeEpoch: 3, now: 7 }).allowed).toBe(
      false,
    );
    expect(decideEmptyTrash({ confirm: true, entries: [], purgeEpoch: 3, now: 7 }).allowed).toBe(
      false,
    );
    const ok = decideEmptyTrash({ confirm: true, entries, purgeEpoch: 3, now: 7 });
    expect(ok.allowed).toBe(true);
    if (ok.allowed) {
      expect(ok.events).toHaveLength(2);
      expect(ok.events.map((e) => e.type)).toEqual(['TrashPurged', 'TrashPurged']);
      expect(ok.events[1]?.payload).toMatchObject({ kind: 'mission', id: 'm1', purgedAt: 7 });
    }
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
      expect(d.events[2]?.payload).toEqual({ missionId: 'a' });
      expect(d.inverseAtom?.payload).toMatchObject({ fromId: 'a', intoId: 'b' });
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

describe('resume legality (C7 + §6.5) + undo-atom refinements (Spec §5.12)', () => {
  it('resume requires PARKED/ARCHIVED; partial must be a non-empty membership subset', () => {
    const base = { missionId: 'm1', memberTabIds: ['t1', 't2'] };
    expect(decideResume({ ...base, state: 'live', mode: 'full' }).allowed).toBe(false);
    expect(decideResume({ ...base, state: 'trash', mode: 'full' }).allowed).toBe(false);
    expect(decideResume({ ...base, state: 'parked', mode: 'partial', tabIds: [] }).allowed).toBe(
      false,
    );
    expect(
      decideResume({ ...base, state: 'parked', mode: 'partial', tabIds: ['t9'] }).allowed,
    ).toBe(false);
    const full = decideResume({ ...base, state: 'archived', mode: 'full' });
    expect(full.allowed).toBe(true);
    if (full.allowed) {
      expect(full.events[0]?.type).toBe('ResumeAccepted');
      expect(full.events[0]?.payload).toMatchObject({ missionId: 'm1', mode: 'full' });
    }
    const partial = decideResume({ ...base, state: 'parked', mode: 'partial', tabIds: ['t2'] });
    expect(partial.allowed).toBe(true);
  });
  it('rename inverse atom restores the previous name; absent old name ⇒ no atom', () => {
    const withPrev = decideRename('m1', 'New', 'user', ' Old ');
    expect(withPrev.allowed && withPrev.inverseAtom?.payload).toMatchObject({
      missionId: 'm1',
      name: 'Old',
    });
    const without = decideRename('m1', 'New', 'user');
    expect(without.allowed && without.inverseAtom === undefined).toBe(true);
  });
  it('split atom names the source so undo can re-home the selection', () => {
    const d = decideSplit('m-new', ['t1'], ['t1', 't2'], undefined, 'user', 'm-src');
    expect(d.allowed && d.inverseAtom?.payload).toMatchObject({
      sourceMissionId: 'm-src',
      shellMissionId: 'm-new',
    });
    if (d.allowed) expect(d.events[1]?.payload).toMatchObject({ fromMissionId: 'm-src' });
  });
  it('undo-replay restore skips the C16 retention window; user path does not', () => {
    const retention = trashRetentionMsOf(DEFAULT_LIFECYCLE_POLICY);
    const base = {
      kind: 'tab' as const,
      id: 't1',
      state: 'trash',
      parentMissionId: 'm1',
      parentState: 'live',
      resolvedMissionId: 'm1',
      deletedAt: 0,
      now: retention + 1,
      trashRetentionMs: retention,
    };
    expect(decideTrashRestore(base).allowed).toBe(false);
    expect(decideTrashRestore({ ...base, viaUndo: true }).allowed).toBe(true);
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

// ── §4 closed-world law (REGRESSION: E3 slice-C audit caught plan payloads drifting
//    from the frozen catalog — ParkIntentAccepted without intentId, a summary-shaped
//    TrashPurged). Every event ANY decider can plan must be a known §4 type whose
//    payload validates against EVENT_REGISTRY field kinds, ids included. ─────────────
describe('§4 catalog parity — every planned event validates against the frozen registry', () => {
  // Kernel Id shape (Crockford-32, 26 chars, leading 0-7): zero-padded two-digit suffix.
  const idOf = (n: number): string => `000000000000000000000000${String(n).padStart(2, '0')}`;
  const decisions: { readonly label: string; readonly events: readonly PlannedEvent[] }[] = [];
  const collect = (label: string, decision: Decision): void => {
    expect(decision.allowed).toBe(true);
    if (decision.allowed) decisions.push({ label, events: decision.events });
  };
  collect(
    'park',
    decideParkPlan({
      tabIds: [idOf(1)],
      groupStyles: [],
      snapshotId: idOf(2),
      intentId: idOf(3),
      issuedAt: 1,
    }),
  );
  collect('rename', decideRename(idOf(4), 'Deep Work', 'user', 'Old Work'));
  collect('merge', decideMerge(idOf(5), idOf(6), [idOf(7)], 'live', 'archived'));
  collect('split', decideSplit(idOf(8), [idOf(9)], [idOf(9)], 'Focus', 'user', idOf(22)));
  collect(
    'resume',
    decideResume({
      missionId: idOf(23),
      state: 'parked',
      mode: 'partial',
      tabIds: [idOf(24)],
      memberTabIds: [idOf(24), idOf(25)],
    }),
  );
  collect('archive', decideArchive(idOf(10), 'live'));
  collect('conclude', decideConclude(idOf(11), 'archived', 'done'));
  collect(
    'trash',
    decideTrash({
      kind: 'tab',
      id: idOf(12),
      state: 'kept',
      parentMissionId: idOf(13),
      bulkThreshold: BULK,
      now: 1,
    }),
  );
  collect(
    'trash-restore',
    decideTrashRestore({
      kind: 'tab',
      id: idOf(14),
      state: 'trash',
      parentMissionId: idOf(15),
      parentState: 'trash',
      resolvedMissionId: idOf(16),
      deletedAt: 0,
      now: 1,
      trashRetentionMs: 9_999,
      domainName: 'example.com',
    }),
  );
  collect(
    'empty-trash',
    decideEmptyTrash({
      confirm: true,
      entries: [{ kind: 'tab', id: idOf(17) }],
      purgeEpoch: 3,
      now: 7,
    }),
  );
  collect(
    'purge-subject',
    decidePurgeSubject({
      subject: { kind: 'mission', id: idOf(18) },
      state: 'trash',
      purgeEpoch: 3,
      now: 7,
    }),
  );
  collect(
    'move',
    decideMove({
      tabIds: [idOf(19)],
      toMissionId: idOf(20),
      destinationState: 'live',
      tabStates: { [idOf(19)]: 'kept' },
      tabSources: { [idOf(19)]: idOf(21) },
    }),
  );

  it('every decider family contributes events (coverage anchor)', () => {
    expect(decisions.length).toBe(12);
    expect(decisions.every((d) => d.events.length > 0)).toBe(true);
  });
  it('every planned event is a known §4 type with a registry-valid payload', () => {
    for (const { label, events } of decisions) {
      for (const planned of events) {
        expect(isKnownEventType(planned.type), `${label}:${planned.type}`).toBe(true);
        const checked = validatePayload(planned.type, planned.payload);
        expect(
          checked.ok,
          `${label}:${planned.type} payload ${JSON.stringify(planned.payload)}`,
        ).toBe(true);
      }
    }
  });
});
