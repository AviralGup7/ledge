// E3-APP · domain/lifecycle legality engine (EES §2.5) — pure deciders for every MVP
// lifecycle transition. Laws enforced here (the §2.5 invariant set):
//   (i)   Park requires a SNAPSHOT PLAN before intent acceptance is proposed — a park
//         plan whose snapshotRef is absent never yields an accepted proposal.
//   (ii)  System-decided deletion of KEPT content is UNREACHABLE — purge/condemn
//         deciders only admit subjects already in the trash.
//   (iii) Every destructive decision carries an inverse atom (undo law §4
//         EntityTrashed{inverseAtom} + meta.undoStack).
// Plus the contract/§10-R transition rules (C9–C18 validation highlights, R13
// dead-parent restore, conclude-implies-archived, bulk-confirm-C15).
// Same inputs ⇒ same decision: deciders take plain data, return data, NEVER mutate,
// NEVER read clocks/ids themselves (ids/times arrive inside inputs).

// Plan shapes are decider OUTPUT, not envelopes — application services forge
// EventEnvelopes from them (ids, HLC, seq are the hub's, not the domain's).
export interface PlannedEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Inverse atom persisted with destructive events; Undo replays it through the hub. */
export interface InverseAtom {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Copy-catalog KEY for the undo descriptor (§3.2: payloads carry keys, never copy). */
  readonly label: string;
}

export type Decision =
  | {
      readonly allowed: true;
      readonly events: readonly PlannedEvent[];
      readonly inverseAtom?: InverseAtom | undefined;
    }
  | { readonly allowed: false; readonly reason: string };

const refuse = (reason: string): Decision => ({ allowed: false, reason });
const allow = (events: readonly PlannedEvent[], inverseAtom?: InverseAtom): Decision => ({
  allowed: true,
  events,
  ...(inverseAtom !== undefined ? { inverseAtom } : {}),
});

// ── Park (C3–C6): plan before intent (invariant i) ────────────────────────────────

export interface ParkPlanInput {
  readonly tabIds: readonly string[];
  readonly groupStyles: readonly unknown[];
  /** Snapshot proof: the use case MUST have materialized snapshot plans first. */
  readonly snapshotId: string | undefined;
  readonly issuedAt: number;
}

export const decideParkPlan = (input: ParkPlanInput): Decision => {
  if (input.tabIds.length === 0) return refuse('park-empty-scope');
  if (input.snapshotId === undefined || input.snapshotId.length === 0)
    return refuse('park-without-snapshot-plan');
  return allow([
    {
      type: 'ParkIntentAccepted',
      payload: {
        scope: {
          tabIds: [...input.tabIds],
          groupStyles: [...input.groupStyles],
          snapshotId: input.snapshotId,
        },
        issuedAt: input.issuedAt,
      },
    },
  ]);
};

// ── Mission-level family (C2, C9, C11, C12, C13, C14) ─────────────────────────────

export const decideRename = (missionId: string, name: string, namedBy: string): Decision => {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return refuse('rename-empty-after-trim');
  return allow([{ type: 'MissionRenamed', payload: { missionId, name: trimmed, namedBy } }], {
    kind: 'rename-mission',
    payload: { missionId, name: trimmed },
    label: 'msg.undo.renamed',
  });
};

export const decideMerge = (
  fromId: string,
  intoId: string,
  fromTabs: readonly string[],
  fromState: string,
  toState: string,
): Decision => {
  if (fromId === intoId) return refuse('merge-self');
  if (fromState === 'trash' || toState === 'trash') return refuse('merge-involves-trash');
  // §4 catalog law: TabMoved is PER-TAB singular ({tabId, missionId, fromMissionId?});
  // merge composes one per member + MissionArchived for the emptied container.
  const moves: PlannedEvent[] = fromTabs.map((tabId) => ({
    type: 'TabMoved',
    payload: { tabId, missionId: intoId, fromMissionId: fromId },
  }));
  return allow(
    [...moves, { type: 'MissionArchived', payload: { missionId: fromId, mergedInto: intoId } }],
    {
      kind: 'split-merged',
      payload: { fromId, intoId, tabIds: [...fromTabs] },
      label: 'msg.undo.merged',
    },
  );
};

/** newMissionId arrives minted (domain law: ids enter through inputs, never from inside). */
export const decideSplit = (
  newMissionId: string,
  tabIds: readonly string[],
  sourceTabIds: readonly string[],
  newMissionName: string | undefined,
  namedBy: string,
): Decision => {
  if (newMissionId.length === 0) return refuse('split-idless-target');
  if (tabIds.length === 0) return refuse('split-empty-selection');
  const contained = tabIds.every((t) => sourceTabIds.includes(t));
  if (!contained) return refuse('split-selection-not-subset');
  const moves: PlannedEvent[] = tabIds.map((tabId) => ({
    type: 'TabMoved',
    payload: { tabId, missionId: newMissionId },
  }));
  return allow(
    [
      {
        type: 'MissionFormed',
        payload: {
          missionId: newMissionId,
          name: newMissionName ?? 'Untitled mission',
          namedBy,
          tabIds: [...tabIds],
          provenance: 'split',
        },
      },
      ...moves,
    ],
    { kind: 'merge-back', payload: { tabIds: [...tabIds] }, label: 'msg.undo.split' },
  );
};

export const decideArchive = (missionId: string, state: string): Decision => {
  if (state === 'trash') return refuse('archive-trash');
  return allow([{ type: 'MissionArchived', payload: { missionId } }], {
    kind: 'unarchive',
    payload: { missionId },
    label: 'msg.undo.archived',
  });
};

/** C14: conclude implies archived (§4 event chain); conclude from parked/archived only. */
export const decideConclude = (
  missionId: string,
  state: string,
  outcomeNote: string | undefined,
): Decision => {
  if (state !== 'parked' && state !== 'archived')
    return refuse('conclude-requires-parked-or-archived');
  if (outcomeNote !== undefined && outcomeNote.trim().length === 0)
    return refuse('conclude-blank-note');
  return allow([
    {
      type: 'MissionConcluded',
      payload: {
        missionId,
        ...(outcomeNote !== undefined ? { outcomeNote: outcomeNote.trim() } : {}),
      },
    },
    { type: 'MissionArchived', payload: { missionId } },
  ]);
};

// ── Trash family (C15, C16, C17 + §10-R13) — destructive ⇒ inverse atoms ──────────

export const decideTrash = (input: {
  readonly kind: 'tab' | 'mission';
  readonly id: string;
  readonly state: string;
  readonly parentMissionId?: string | undefined;
  readonly bulkSize?: number | undefined;
  readonly confirmedLarge?: boolean | undefined;
  readonly bulkThreshold: number;
  readonly now: number;
}): Decision => {
  if (input.state === 'trash') return refuse('already-trash');
  const size = input.bulkSize ?? 1;
  if (size > input.bulkThreshold && input.confirmedLarge !== true)
    return refuse('bulk-confirm-required');
  return allow(
    [
      {
        type: 'EntityTrashed',
        payload: {
          kind: input.kind,
          id: input.id,
          deletedAt: input.now,
          inverseAtom: {
            kind: `restore-${input.kind}`,
            payload: {
              kind: input.kind,
              id: input.id,
              ...(input.parentMissionId !== undefined
                ? { parentMissionId: input.parentMissionId }
                : {}),
            },
            label: input.kind === 'tab' ? 'msg.undo.trashed-tab' : 'msg.undo.trashed-mission',
          },
        },
      },
    ],
    {
      kind: `restore-${input.kind}`,
      payload: {
        kind: input.kind,
        id: input.id,
        ...(input.parentMissionId !== undefined ? { parentMissionId: input.parentMissionId } : {}),
      },
      label: input.kind === 'tab' ? 'msg.undo.trashed-tab' : 'msg.undo.trashed-mission',
    },
  );
};

/** §10-R13: restoring a tab whose parent mission is gone (hard-purged or never existed)
 *  resolves by RE-CREATING a minimal mission (name = tab.domain, namedBy=system).
 *  resolvedMissionId arrives minted (ids enter through inputs). */
export const decideTrashRestore = (input: {
  readonly kind: 'tab' | 'mission';
  readonly id: string;
  readonly state: string;
  readonly parentMissionId: string | undefined;
  readonly parentState: string | undefined;
  readonly resolvedMissionId: string;
  readonly deletedAt: number;
  readonly now: number;
  readonly trashRetentionMs: number;
  readonly domainName?: string | undefined;
}): Decision => {
  if (input.state !== 'trash') return refuse('restore-not-in-trash');
  if (input.now - input.deletedAt > input.trashRetentionMs) return refuse('restore-window-expired');
  const events: PlannedEvent[] = [];
  if (input.parentState === undefined || input.parentState === 'trash') {
    events.push({
      type: 'MissionFormed',
      payload: {
        missionId: input.resolvedMissionId,
        name: input.domainName ?? 'Recovered mission',
        namedBy: 'system',
        tabIds: [input.id],
        provenance: 'trash-restore-parent',
      },
    });
  }
  events.push({
    type: 'TrashRestored',
    payload: { kind: input.kind, id: input.id, resolvedMissionId: input.resolvedMissionId },
  });
  return allow(events);
};

/** Empty-trash purge subjects are the trash set ONLY (invariant ii), confirm-exact C17. */
export const decideEmptyTrash = (input: {
  readonly confirm: unknown;
  readonly trashEntryCount: number;
  readonly now: number;
}): Decision => {
  if (input.confirm !== true) return refuse('empty-trash-confirm-exact');
  if (input.trashEntryCount === 0) return refuse('empty-trash-no-entries');
  return allow([
    {
      type: 'TrashPurged',
      payload: { purgedAt: input.now, purged: input.trashEntryCount },
    },
  ]);
};

/** Purge/condemn of a single subject (sweeper path): absolutely refuse non-trash.
 *  Invariant (ii) encoded as a refusal the sweeper calls — KEPT content has NO purge
 *  decision path anywhere in the domain. */
export const decidePurgeSubject = (state: string): Decision => {
  if (state !== 'trash') return refuse('purge-of-non-trash-unreachable');
  return allow([{ type: 'TrashPurged', payload: {} }]);
};

// ── Move (C10) + undo (C18) ───────────────────────────────────────────────────────

export const decideMove = (input: {
  readonly tabIds: readonly string[];
  readonly toMissionId: string;
  readonly destinationState: string;
  readonly tabStates: Readonly<Record<string, string>>;
  /** Source mission per tab (for fromMissionId sequencing per §4). */
  readonly tabSources: Readonly<Record<string, string>>;
}): Decision => {
  if (input.tabIds.length === 0) return refuse('move-empty-selection');
  if (input.destinationState === 'trash') return refuse('move-into-trash');
  for (const id of input.tabIds) {
    const state = input.tabStates[id];
    if (state !== 'live' && state !== 'kept') return refuse(`move-tab-not-kept-or-live:${id}`);
  }
  const moves: PlannedEvent[] = input.tabIds.map((tabId) => {
    const from = input.tabSources[tabId];
    return {
      type: 'TabMoved',
      payload: {
        tabId,
        missionId: input.toMissionId,
        ...(from !== undefined && from !== input.toMissionId ? { fromMissionId: from } : {}),
      },
    };
  });
  return allow(moves, {
    kind: 'move-back',
    payload: { tabIds: [...input.tabIds], tabSources: { ...input.tabSources } },
    label: 'msg.undo.moved',
  });
};

/** C18 + §10-R9: undo pops the stack, NEVER auto-retried (dispatcher registration law).
 *  Undo emits NO novel event — the services replay the popped inverse atom as that
 *  atom's own catalog events (TrashRestored, MissionRenamed...), keeping the journal
 *  a closed replayable world. */
export const decideUndo = (stackDepth: number): Decision => {
  if (stackDepth <= 0) return refuse('undo-empty-stack');
  return allow([]);
};
