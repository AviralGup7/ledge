// E3-APP · Mission use-case service (C2 StartMission · C9 Rename · C10 MoveTabs ·
// C11 Merge · C12 Split · C13 Archive · C14 Conclude). One service per the mission
// brief; every write flows: read rows → DOMAIN DECIDER (EES §2.5) → serialized commit
// (stream appender) → DTO-shaped response. Refusals map to calm catalog errors —
// E_DOMAIN_LEGALITY for legality, E_DOMAIN_UNDO_CONFLICT for optimistic-currency
// aborts — never an infrastructure detail.
import type { Decision } from '@/domain/lifecycle/index.js';
import {
  decideArchive,
  decideConclude,
  decideMerge,
  decideMove,
  decideRename,
  decideSplit,
  policyOf,
} from '@/domain/lifecycle/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import type { UndoEntry } from './shared/undo-stack.js';
import { pushUndoHinge, UNDO_STACK_STORES } from './shared/undo-stack.js';
import {
  missionNameOf,
  missionStateOf,
  missionTabIdsOf,
  readMission,
  readSettingsRows,
  readTab,
  tabMissionOf,
  tabStateOf,
} from './shared/rows.js';

/** decision→err mapping (closed catalog law: legality refusals share one code). */
const legalityErr = (operation: string, decision: Decision): LedgeError => {
  const reason = decision.allowed ? 'unknown' : decision.reason;
  return ledgeError('E_DOMAIN_LEGALITY', { operation, reason });
};

export interface MissionService {
  /** C2: window-first-then-truth (browser created before any journal byte; a browser
   *  failure commits nothing). */
  start(
    input: { readonly name?: string | undefined },
    ctx: UseCtx,
  ): Promise<Result<{ readonly missionId: string; readonly windowId: number }, LedgeError>>;
  rename(
    input: { readonly missionId: string; readonly name: string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly oldName?: string | undefined }, LedgeError>>;
  archive(
    input: { readonly missionId: string },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
  conclude(
    input: { readonly missionId: string; readonly outcomeNote?: string | undefined },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
  merge(
    input: { readonly fromId: string; readonly intoId: string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly intoId: string }, LedgeError>>;
  split(
    input: { readonly tabIds: readonly string[]; readonly newName?: string | undefined },
    ctx: UseCtx,
  ): Promise<Result<{ readonly newMissionId: string }, LedgeError>>;
  moveTabs(
    input: { readonly tabIds: readonly string[]; readonly toMissionId: string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly moved: number }, LedgeError>>;
}

export const createMissionService = (edge: ServiceEdge): MissionService => {
  const { deps, appender } = edge;
  const op = (family: string): string => `command:${family}`;

  /** Shared write tail: undo-atom hinge when the decision carries one. */
  const commitDecision = async (
    family: string,
    cid: string,
    decision: Decision & { readonly allowed: true },
  ): Promise<Result<undefined, LedgeError>> => {
    let hinge: Parameters<typeof appender.commit>[0]['hinge'];
    if (decision.inverseAtom !== undefined) {
      const settings = await readSettingsRows(deps.engine);
      const cap = policyOf(settings.ok ? settings.value : undefined).undoStackCap;
      const entry: UndoEntry = {
        atomId: deps.ids.nextId(),
        kind: decision.inverseAtom.kind,
        payload: decision.inverseAtom.payload,
        label: decision.inverseAtom.label,
        pushedAt: deps.now(),
      };
      hinge = { extraStores: UNDO_STACK_STORES, write: pushUndoHinge(entry, cap) };
    }
    const committed = await appender.commit({
      plans: decision.events.map((e) => ({ type: e.type, payload: e.payload })),
      key: opKey(edge, family, cid),
      ...(hinge !== undefined ? { hinge } : {}),
    });
    if (!committed.ok) return err(committed.error);
    return ok(undefined);
  };

  return {
    start: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      ctx.progress({ stage: 1 });
      // Window FIRST (§6 mission-park reading of C2): browser failure ⇒ no bytes.
      const created = await deps.windows.create({});
      if (!created.ok) return err(created.error);
      ctx.progress({ stage: 2 });
      const missionId = deps.ids.nextId();
      const committed = await appender.commit({
        plans: [
          {
            type: 'MissionFormed',
            payload: {
              missionId,
              name: (input.name ?? '').replace(/\s+/g, ' ').trim() || 'Untitled mission',
              namedBy: 'user',
              tabIds: [],
              provenance: 'start',
            },
          },
        ],
        key: opKey(edge, 'StartMission', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      ctx.progress({ stage: 3 });
      return ok({ missionId, windowId: created.value });
    },

    rename: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const rowR = await readMission(deps.engine, input.missionId);
      if (!rowR.ok) return err(rowR.error);
      if (rowR.value === undefined)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: op('RenameMission'),
            reason: 'mission-missing',
          }),
        );
      const oldName = missionNameOf(rowR.value);
      const decision = decideRename(input.missionId, input.name, 'user', oldName);
      if (!decision.allowed) return err(legalityErr(op('RenameMission'), decision));
      const committed = await commitDecision('RenameMission', ctx.cid, decision);
      if (!committed.ok) return err(committed.error);
      return ok({ ...(oldName.length > 0 ? { oldName } : {}) });
    },

    archive: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const rowR = await readMission(deps.engine, input.missionId);
      if (!rowR.ok) return err(rowR.error);
      const decision = decideArchive(input.missionId, missionStateOf(rowR.value));
      if (!decision.allowed) return err(legalityErr(op('ArchiveMission'), decision));
      const committed = await commitDecision('ArchiveMission', ctx.cid, decision);
      if (!committed.ok) return err(committed.error);
      return ok({});
    },

    conclude: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const rowR = await readMission(deps.engine, input.missionId);
      if (!rowR.ok) return err(rowR.error);
      const decision = decideConclude(
        input.missionId,
        missionStateOf(rowR.value),
        input.outcomeNote,
      );
      if (!decision.allowed) return err(legalityErr(op('ConcludeMission'), decision));
      const committed = await commitDecision('ConcludeMission', ctx.cid, decision);
      if (!committed.ok) return err(committed.error);
      return ok({});
    },

    merge: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const fromR = await readMission(deps.engine, input.fromId);
      if (!fromR.ok) return err(fromR.error);
      if (fromR.value === undefined)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: op('MergeMissions'),
            reason: 'mission-missing',
          }),
        );
      const intoR = await readMission(deps.engine, input.intoId);
      if (!intoR.ok) return err(intoR.error);
      if (intoR.value === undefined)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: op('MergeMissions'),
            reason: 'mission-missing',
          }),
        );
      const decision = decideMerge(
        input.fromId,
        input.intoId,
        missionTabIdsOf(fromR.value),
        missionStateOf(fromR.value),
        missionStateOf(intoR.value),
      );
      if (!decision.allowed) return err(legalityErr(op('MergeMissions'), decision));
      const committed = await commitDecision('MergeMissions', ctx.cid, decision);
      if (!committed.ok) return err(committed.error);
      return ok({ intoId: input.intoId });
    },

    split: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      // v1 source law: the selection must share exactly one source mission.
      let source = '';
      const sourceTabs: string[] = [];
      for (const tabId of input.tabIds) {
        const tabR = await readTab(deps.engine, tabId);
        if (!tabR.ok) return err(tabR.error);
        const missionId = tabMissionOf(tabR.value);
        if (tabR.value === undefined || missionId.length === 0)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', {
              operation: op('SplitMission'),
              reason: 'tab-missing',
            }),
          );
        if (source.length === 0) source = missionId;
        if (missionId !== source)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', {
              operation: op('SplitMission'),
              reason: 'split-multi-source',
            }),
          );
      }
      if (source.length > 0) {
        const srcRowR = await readMission(deps.engine, source);
        if (!srcRowR.ok) return err(srcRowR.error);
        sourceTabs.push(...missionTabIdsOf(srcRowR.value));
      }
      const newMissionId = deps.ids.nextId();
      const decision = decideSplit(
        newMissionId,
        input.tabIds,
        sourceTabs,
        input.newName,
        'user',
        source.length > 0 ? source : undefined,
      );
      if (!decision.allowed) return err(legalityErr(op('SplitMission'), decision));
      const committed = await commitDecision('SplitMission', ctx.cid, decision);
      if (!committed.ok) return err(committed.error);
      return ok({ newMissionId });
    },

    moveTabs: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const destR = await readMission(deps.engine, input.toMissionId);
      if (!destR.ok) return err(destR.error);
      if (destR.value === undefined)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: op('MoveTabs'),
            reason: 'destination-missing',
          }),
        );
      const tabStates: Record<string, string> = {};
      const tabSources: Record<string, string> = {};
      for (const tabId of input.tabIds) {
        const tabR = await readTab(deps.engine, tabId);
        if (!tabR.ok) return err(tabR.error);
        if (tabR.value === undefined)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: op('MoveTabs'), reason: 'tab-missing' }),
          );
        tabStates[tabId] = tabStateOf(tabR.value);
        tabSources[tabId] = tabMissionOf(tabR.value);
      }
      const decision = decideMove({
        tabIds: input.tabIds,
        toMissionId: input.toMissionId,
        destinationState: missionStateOf(destR.value),
        tabStates,
        tabSources,
      });
      if (!decision.allowed) return err(legalityErr(op('MoveTabs'), decision));
      const committed = await commitDecision('MoveTabs', ctx.cid, decision);
      if (!committed.ok) return err(committed.error);
      return ok({ moved: input.tabIds.length });
    },
  };
};
