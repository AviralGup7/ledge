// E3-APP · Trash use-case service (C15 DeleteEntity · C16 RestoreFromTrash · C17
// EmptyTrash). Laws on duty: §2.5 invariants (ii: system purge of KEPT unreachable —
// the service NEVER offers a non-trash subject; iii: destructive ⇒ inverse atom),
// C15 bulk-confirm (delegated to the domain), C16 within-retention + §10-R13
// dead-parent re-creation, C17 confirm-exact. Mission trash cascades to member tabs
// under one bulkId (the restore set is re-derivable, never denormalized).
import {
  decideEmptyTrash,
  decideTrash,
  decideTrashRestore,
  policyOf,
  trashRetentionMsOf,
  type Decision,
} from '@/domain/lifecycle/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import type { UndoEntry } from './shared/undo-stack.js';
import { pushUndoHinge, UNDO_STACK_STORES } from './shared/undo-stack.js';
import {
  missionStateOf,
  readMission,
  readSettingsRows,
  readTab,
  readTabsByMission,
  readTrashedMissions,
  readTrashedTabs,
  tabMissionOf,
  tabStateOf,
} from './shared/rows.js';
import type { PlannedPlan } from './shared/stream-appender.js';

const DOMAIN_OP = 'command:trash';

export interface TrashService {
  deleteEntity(
    input: {
      readonly kind: 'tab' | 'mission';
      readonly id: string;
      readonly bulkSize?: number | undefined;
      readonly confirmedLarge?: boolean | undefined;
    },
    ctx: UseCtx,
  ): Promise<Result<{ readonly trashed: number }, LedgeError>>;
  restore(
    input: { readonly kind: 'tab' | 'mission'; readonly id: string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly missionId: string }, LedgeError>>;
  emptyTrash(
    input: { readonly confirm: boolean },
    ctx: UseCtx,
  ): Promise<Result<{ readonly purged: number }, LedgeError>>;
}

export const createTrashService = (edge: ServiceEdge): TrashService => {
  const { deps, appender } = edge;

  const trashPolicy = async () => {
    const settings = await readSettingsRows(deps.engine);
    const policy = policyOf(settings.ok ? settings.value : undefined);
    return { policy, retentionMs: trashRetentionMsOf(policy) };
  };

  const purgeEpochOf = async (): Promise<Result<number, LedgeError>> => {
    const baseline = await deps.journal.compactionState(deps.deviceId);
    if (!baseline.ok) return err(baseline.error);
    // Current epoch derives from the compaction baseline (§5 meta.purgeEpoch);
    // pre-first-compaction streams live at epoch 0.
    return ok(baseline.value === null ? 0 : baseline.value.epoch);
  };

  return {
    deleteEntity: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const { policy } = await trashPolicy();
      const bulkId = deps.ids.nextId();
      const plans: PlannedPlan[] = [];
      const atoms: UndoEntry[] = [];
      const push = (decision: Decision): Result<undefined, LedgeError> => {
        if (!decision.allowed)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: decision.reason }),
          );
        for (const e of decision.events) plans.push({ type: e.type, payload: e.payload });
        if (decision.inverseAtom !== undefined) {
          atoms.push({
            atomId: deps.ids.nextId(),
            kind: decision.inverseAtom.kind,
            payload: decision.inverseAtom.payload,
            label: decision.inverseAtom.label,
            pushedAt: deps.now(),
          });
        }
        return ok(undefined);
      };

      if (input.kind === 'tab') {
        const tabR = await readTab(deps.engine, input.id);
        if (!tabR.ok) return err(tabR.error);
        if (tabR.value === undefined)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: 'tab-missing' }),
          );
        const decision = decideTrash({
          kind: 'tab',
          id: input.id,
          state: tabStateOf(tabR.value),
          parentMissionId: tabMissionOf(tabR.value) || undefined,
          bulkSize: input.bulkSize,
          confirmedLarge: input.confirmedLarge,
          bulkThreshold: policy.bulkConfirmThreshold,
          now: deps.now(),
        });
        const pushed = push(decision);
        if (!pushed.ok) return pushed;
        // Stamp the cascade batch id onto the single-entity trash too (trash provenance).
        plans[0] = {
          type: plans[0]?.type ?? 'EntityTrashed',
          payload: { ...(plans[0]?.payload ?? {}), bulkId },
        };
      } else {
        const missionR = await readMission(deps.engine, input.id);
        if (!missionR.ok) return err(missionR.error);
        if (missionR.value === undefined)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: 'mission-missing' }),
          );
        const memberR = await readTabsByMission(deps.engine, input.id);
        if (!memberR.ok) return err(memberR.error);
        const members = memberR.value
          .map((r) => r['ledgeTabId'])
          .filter((x): x is string => typeof x === 'string');
        const cascade = members.length + 1;
        const decision = decideTrash({
          kind: 'mission',
          id: input.id,
          state: missionStateOf(missionR.value),
          ...(input.bulkSize !== undefined || cascade > 1
            ? { bulkSize: Math.max(input.bulkSize ?? 0, cascade) }
            : {}),
          confirmedLarge: input.confirmedLarge,
          bulkThreshold: policy.bulkConfirmThreshold,
          now: deps.now(),
        });
        const pushed = push(decision);
        if (!pushed.ok) return pushed;
        plans[0] = {
          type: plans[0]?.type ?? 'EntityTrashed',
          payload: { ...(plans[0]?.payload ?? {}), bulkId },
        };
        // Cascade: member tabs bin with their container, each carrying its own
        // restore atom (the restore set is per-entity lawful, grouped by bulkId).
        for (const member of members) {
          const memberDecision = decideTrash({
            kind: 'tab',
            id: member,
            state: 'kept',
            parentMissionId: input.id,
            confirmedLarge: true,
            bulkThreshold: policy.bulkConfirmThreshold,
            now: deps.now(),
          });
          const memberPushed = push(memberDecision);
          if (!memberPushed.ok) return memberPushed;
          plans[plans.length - 1] = {
            type: plans[plans.length - 1]?.type ?? 'EntityTrashed',
            payload: { ...(plans[plans.length - 1]?.payload ?? {}), bulkId },
          };
        }
      }

      const sole = atoms.at(0);
      if (sole === undefined)
        return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-missing' }));
      const mergedAtom: UndoEntry =
        atoms.length === 1
          ? sole
          : {
              atomId: deps.ids.nextId(),
              kind: 'restore-cascade',
              payload: { bulkId, missionId: input.id, count: atoms.length },
              label: 'msg.undo.trashed-mission',
              pushedAt: deps.now(),
            };
      const committed = await appender.commit({
        plans,
        key: opKey(edge, 'DeleteEntity', ctx.cid),
        hinge: {
          extraStores: UNDO_STACK_STORES,
          write: pushUndoHinge(mergedAtom, policy.undoStackCap),
        },
      });
      if (!committed.ok) return err(committed.error);
      return ok({ trashed: input.kind === 'tab' ? 1 : plans.length });
    },

    restore: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const { retentionMs } = await trashPolicy();
      const now = deps.now();
      if (input.kind === 'tab') {
        const tabR = await readTab(deps.engine, input.id);
        if (!tabR.ok) return err(tabR.error);
        if (tabR.value === undefined)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: 'tab-missing' }),
          );
        const parentId = tabMissionOf(tabR.value);
        const parentRowR =
          parentId.length > 0
            ? await readMission(deps.engine, parentId)
            : ({ ok: true, value: undefined } as Result<undefined, LedgeError>);
        if (!parentRowR.ok) return err(parentRowR.error);
        const parentAlive =
          parentRowR.value !== undefined && missionStateOf(parentRowR.value) !== 'trash';
        const resolvedMissionId = parentAlive && parentId.length > 0 ? parentId : deps.ids.nextId();
        const decision = decideTrashRestore({
          kind: 'tab',
          id: input.id,
          state: tabStateOf(tabR.value),
          parentMissionId: parentId.length > 0 ? parentId : undefined,
          parentState: parentId.length > 0 ? missionStateOf(parentRowR.value) : undefined,
          resolvedMissionId,
          deletedAt: typeof tabR.value['deletedAt'] === 'number' ? tabR.value['deletedAt'] : now,
          now,
          trashRetentionMs: retentionMs,
          domainName: typeof tabR.value['domain'] === 'string' ? tabR.value['domain'] : undefined,
        });
        if (!decision.allowed)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: decision.reason }),
          );
        const committed = await appender.commit({
          plans: decision.events.map((e) => ({ type: e.type, payload: e.payload })),
          key: opKey(edge, 'RestoreFromTrash', ctx.cid),
        });
        if (!committed.ok) return err(committed.error);
        return ok({ missionId: resolvedMissionId });
      }

      const missionR = await readMission(deps.engine, input.id);
      if (!missionR.ok) return err(missionR.error);
      if (missionR.value === undefined)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: 'mission-missing' }),
        );
      const decision = decideTrashRestore({
        kind: 'mission',
        id: input.id,
        state: missionStateOf(missionR.value),
        parentMissionId: undefined,
        parentState: undefined,
        resolvedMissionId: input.id,
        deletedAt:
          typeof missionR.value['deletedAt'] === 'number' ? missionR.value['deletedAt'] : now,
        now,
        trashRetentionMs: retentionMs,
      });
      if (!decision.allowed)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: decision.reason }),
        );
      // Cascade: member tabs of this mission currently in trash re-home with it.
      const trashedTabsR = await readTrashedTabs(deps.engine);
      if (!trashedTabsR.ok) return err(trashedTabsR.error);
      const memberRestores: PlannedPlan[] = trashedTabsR.value
        .filter((r) => tabMissionOf(r) === input.id)
        .map((r) => ({
          type: 'TrashRestored',
          payload: { kind: 'tab', id: r['ledgeTabId'], resolvedMissionId: input.id },
        }));
      const committed = await appender.commit({
        plans: [
          ...decision.events.map((e) => ({ type: e.type, payload: e.payload })),
          ...memberRestores,
        ],
        key: opKey(edge, 'RestoreFromTrash', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({ missionId: input.id });
    },

    emptyTrash: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const tabsR = await readTrashedTabs(deps.engine);
      if (!tabsR.ok) return err(tabsR.error);
      const missionsR = await readTrashedMissions(deps.engine);
      if (!missionsR.ok) return err(missionsR.error);
      const entries = [
        ...tabsR.value.map((r) => ({ kind: 'tab' as const, id: String(r['ledgeTabId']) })),
        ...missionsR.value.map((r) => ({ kind: 'mission' as const, id: String(r['missionId']) })),
      ];
      const epochR = await purgeEpochOf();
      if (!epochR.ok) return err(epochR.error);
      const decision = decideEmptyTrash({
        confirm: input.confirm,
        entries,
        purgeEpoch: epochR.value + 1,
        now: deps.now(),
      });
      if (!decision.allowed)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: decision.reason }),
        );
      const committed = await appender.commit({
        plans: decision.events.map((e) => ({ type: e.type, payload: e.payload })),
        key: opKey(edge, 'EmptyTrash', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({ purged: decision.events.length });
    },
  };
};
