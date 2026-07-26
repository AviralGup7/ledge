// E3-APP · Undo service (C18 + Spec §5.12 universal undo + §10-R9 never-auto-retry).
// The stack entry is an INVERSE ATOM (data); undo replays it THROUGH THE HUB as that
// atom's own §4-catalog events (TrashRestored, MissionRenamed, TabMoved, MissionResumed
// /MissionArchived state pairs) — the journal stays a closed replayable world and the
// replay is indistinguishable from the forward gesture.
// Atom vocabulary (producers are the deciding services; NEVER invent kinds):
//   restore-tab / restore-mission / restore-cascade — EntityTrashed inverses
//   rename-mission — MissionRenamed{name:prev}
//   move-back — TabMoved re-home per tab
//   merge-back — split inverse: re-home selection + archive the shell
//   split-merged — merge inverse: re-home tabs + re-open the from-mission
//   unarchive — archive inverse: re-open via MissionResumed (§4 has no unarchive
//     event in v1 — the empty-partial resume is the catalog-pure re-open carrier;
//     recorded in docs/adr-notes/e3-app-layer.md)
// Redo (internal Tier-2): v1 replays nothing — undo itself is journal-appended, so a
// redo would need the pre-undo state journal-forward — the forward gesture is the
// redo; the internal service reports the gesture honestly (E_CAPABILITY redo-unscoped,
// Spec §5.12 "Redo wherever redo is coherent — not for restores").
import {
  decideTrashRestore,
  decideUndo,
  policyOf,
  trashRetentionMsOf,
} from '@/domain/lifecycle/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import type { UndoEntry } from './shared/undo-stack.js';
import { popUndoHinge, readUndoStack, UNDO_STACK_STORES } from './shared/undo-stack.js';
import {
  missionStateOf,
  readMission,
  readSettingsRows,
  readTab,
  readTrashedTabs,
  tabMissionOf,
  tabStateOf,
} from './shared/rows.js';
import type { PlannedPlan } from './shared/stream-appender.js';

const DOMAIN_OP = 'command:Undo';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArr = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const strRecord = (v: unknown): Readonly<Record<string, string>> => {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
};

export interface UndoService {
  undo(ctx: UseCtx): Promise<Result<{ readonly undid: string }, LedgeError>>;
  /** Internal Tier-2 (not wire-served in v1): honest unscoped answer per Spec §5.12. */
  redo(ctx: UseCtx): Promise<Result<{ readonly redid: string }, LedgeError>>;
}

export const createUndoService = (edge: ServiceEdge): UndoService => {
  const { deps, appender } = edge;

  /**
   * Atom kind → replay plan (the closed §4 vocabulary). Every plan validates against
   * EVENT_REGISTRY against the atom payloads the deciding services wrote — an atom
   * of unknown provenance fails HERE, honestly (E_CAPABILITY), never corrupts.
   */
  const replayOf = async (
    entry: UndoEntry,
  ): Promise<Result<readonly PlannedPlan[], LedgeError>> => {
    const settings = await readSettingsRows(deps.engine);
    const retentionMs = trashRetentionMsOf(policyOf(settings.ok ? settings.value : undefined));
    const now = deps.now();
    const p = entry.payload;

    switch (entry.kind) {
      case 'restore-tab':
      case 'restore-mission':
      case 'restore-cascade': {
        // One decision path for user-restore and undo-restore (R13 dead-parent rides
        // inside); viaUndo skips ONLY the C16 retention window.
        const kind = entry.kind === 'restore-tab' ? 'tab' : 'mission';
        const id = entry.kind === 'restore-cascade' ? str(p['missionId']) : str(p['id']);
        if (id.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        let parentMissionId = str(p['parentMissionId']);
        if (kind === 'tab') {
          const tabR = await readTab(deps.engine, id);
          if (!tabR.ok) return err(tabR.error);
          if (parentMissionId.length === 0) parentMissionId = tabMissionOf(tabR.value);
          if (tabStateOf(tabR.value) !== 'trash')
            return err(
              ledgeError('E_DOMAIN_UNDO_CONFLICT', { operation: DOMAIN_OP, fault: 'not-in-trash' }),
            );
        }
        // Parent liveness drives R13: an ALIVE parent never re-creates; a dead/missing
        // one resolves through minimal re-formation (decider law).
        let parentState: string | undefined;
        if (kind === 'tab' && parentMissionId.length > 0) {
          const parentR = await readMission(deps.engine, parentMissionId);
          if (!parentR.ok) return err(parentR.error);
          parentState = parentR.value === undefined ? undefined : missionStateOf(parentR.value);
        }
        const parentAlive =
          parentState !== undefined && parentState !== 'trash' && parentMissionId.length > 0;
        const resolvedMissionId =
          kind === 'mission' ? id : parentAlive ? parentMissionId : deps.ids.nextId();
        const decision = decideTrashRestore({
          kind,
          id,
          state: 'trash',
          parentMissionId:
            kind === 'tab' && parentMissionId.length > 0 ? parentMissionId : undefined,
          parentState,
          resolvedMissionId,
          deletedAt: 0,
          now,
          trashRetentionMs: retentionMs,
          viaUndo: true,
        });
        if (!decision.allowed) {
          return err(
            ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: decision.reason }),
          );
        }
        const restores: PlannedPlan[] = decision.events.map((e) => ({
          type: e.type,
          payload: e.payload,
        }));
        if (entry.kind === 'restore-cascade') {
          // Cascade: re-home this mission's currently-trashed member tabs with it
          // (re-derived from live trash state — never denormalized bulk lists).
          const trashedR = await readTrashedTabs(deps.engine);
          if (!trashedR.ok) return err(trashedR.error);
          for (const row of trashedR.value) {
            if (tabMissionOf(row) !== id) continue;
            const tabId = row['ledgeTabId'];
            if (typeof tabId === 'string' && tabId.length > 0) {
              restores.push({
                type: 'TrashRestored',
                payload: { kind: 'tab', id: tabId, resolvedMissionId: id },
              });
            }
          }
        }
        return ok(restores);
      }

      case 'rename-mission': {
        const missionId = str(p['missionId']);
        const name = str(p['name']);
        if (missionId.length === 0 || name.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        return ok([{ type: 'MissionRenamed', payload: { missionId, name, namedBy: 'system' } }]);
      }

      case 'move-back': {
        const tabIds = strArr(p['tabIds']);
        const sources = strRecord(p['tabSources']);
        if (tabIds.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        const plans: PlannedPlan[] = [];
        for (const tabId of tabIds) {
          const target = str(sources[tabId]);
          if (target.length === 0) continue;
          const tabR = await readTab(deps.engine, tabId);
          if (!tabR.ok) return err(tabR.error);
          const current = tabMissionOf(tabR.value);
          plans.push({
            type: 'TabMoved',
            payload: {
              tabId,
              missionId: target,
              ...(current.length > 0 && current !== target ? { fromMissionId: current } : {}),
            },
          });
        }
        return ok(plans);
      }

      case 'merge-back': {
        // Undo of SPLIT: selection re-homes to its source; the formed shell archives.
        const tabIds = strArr(p['tabIds']);
        const source = str(p['sourceMissionId']);
        const shell = str(p['shellMissionId']);
        if (tabIds.length === 0 || source.length === 0 || shell.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        const plans: PlannedPlan[] = tabIds.map((tabId) => ({
          type: 'TabMoved',
          payload: { tabId, missionId: source, fromMissionId: shell },
        }));
        plans.push({ type: 'MissionArchived', payload: { missionId: shell } });
        return ok(plans);
      }

      case 'split-merged': {
        // Undo of MERGE: tabs re-home to the from-mission; the emptied container
        // re-opens (catalog-pure re-open: empty-partial MissionResumed — §4 has no
        // unarchive event in v1; adr-note recorded).
        const fromId = str(p['fromId']);
        const intoId = str(p['intoId']);
        const tabIds = strArr(p['tabIds']);
        if (fromId.length === 0 || intoId.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        const plans: PlannedPlan[] = tabIds.map((tabId) => ({
          type: 'TabMoved',
          payload: { tabId, missionId: fromId, fromMissionId: intoId },
        }));
        plans.push({
          type: 'MissionResumed',
          payload: { missionId: fromId, mode: 'partial', restoredMapping: { plannedTabIds: [] } },
        });
        return ok(plans);
      }

      case 'unarchive': {
        const missionId = str(p['missionId']);
        if (missionId.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        return ok([
          {
            type: 'MissionResumed',
            payload: { missionId, mode: 'partial', restoredMapping: { plannedTabIds: [] } },
          },
        ]);
      }

      case 'import-undo': {
        // R11 batch-undo: the committed import trashes into the recovery net (one
        // bulkId — the batchId — so the sweep restores as one gesture too).
        const batchId = str(p['batchId']);
        const missionIds = strArr(p['missionIds']);
        const tabIds = strArr(p['tabIds']);
        if (batchId.length === 0)
          return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'atom-payload' }));
        const now = deps.now();
        const plans: PlannedPlan[] = missionIds.map((missionId) => ({
          type: 'EntityTrashed',
          payload: {
            kind: 'mission',
            id: missionId,
            deletedAt: now,
            bulkId: batchId,
            inverseAtom: {
              kind: 'restore-cascade',
              payload: { kind: 'mission', id: missionId },
              label: 'msg.undo.trashed-mission',
            },
          },
        }));
        for (const tabId of tabIds) {
          plans.push({
            type: 'EntityTrashed',
            payload: {
              kind: 'tab',
              id: tabId,
              deletedAt: now,
              bulkId: batchId,
              inverseAtom: {
                kind: 'restore-tab',
                payload: { kind: 'tab', id: tabId },
                label: 'msg.undo.trashed-tab',
              },
            },
          });
        }
        return ok(plans);
      }

      default:
        return err(
          ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: `unknown-atom:${entry.kind}` }),
        );
    }
  };

  return {
    undo: async (ctx) => {
      ctx.token.throwIfCancelled();
      const stackR = await readUndoStack(deps.engine);
      if (!stackR.ok) return err(stackR.error);
      const decision = decideUndo(stackR.value.length);
      if (!decision.allowed)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: DOMAIN_OP, reason: decision.reason }),
        );
      const top = stackR.value[stackR.value.length - 1];
      if (top === undefined)
        return err(ledgeError('E_CAPABILITY', { operation: DOMAIN_OP, fault: 'stack-read' }));
      const replay = await replayOf(top);
      if (!replay.ok) return err(replay.error);
      // Pop rides the replay's hinge with optimistic currency: a moved top aborts the
      // whole commit → E_CAPABILITY(stack-moved) honestly, never double-replay.
      const committed = await appender.commit({
        plans: replay.value,
        key: opKey(edge, 'Undo', ctx.cid),
        hinge: { extraStores: UNDO_STACK_STORES, write: popUndoHinge(top.atomId) },
      });
      if (!committed.ok) return err(committed.error);
      // §3.2: the descriptor is a copy-catalog KEY, never display copy.
      return ok({ undid: top.label });
    },

    redo: async (ctx) => {
      ctx.token.throwIfCancelled();
      return err(
        ledgeError('E_CAPABILITY', { operation: 'command:Redo', fault: 'redo-unscoped-v1' }),
      );
    },
  };
};
