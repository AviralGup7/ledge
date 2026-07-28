// E8-T09 · Switcher use-case — the atomic park+switch (EES C28: "per C5+C7
// chain (atomic via single intent)"; Spec W8: "If park fails, switch aborts…
// user never loses the current context by half-executing a switch"). Laws:
//  * SINGLE INTENT, CHECKPOINTED PHASES: park-current → switch-target. Park
//    failure ABORTS the whole intent (resume never runs — the current
//    context stands). Switch failure after a successful park is an honest
//    partial: the old context is parked (safe, undoable) and the error says
//    exactly which phase — never silent either way.
//  * READS NEVER ACT: listing the switcher is a pure read of projection rows
//    (state-index covered, EES §2.9); ordering is the domain's W8 law.
//  * OPEN TARGETS ANSWER TRUTH, NOT ACTIONS: picking an already-live mission
//    answers its window binding for the HOST to focus — this use-case never
//    reaches a chrome adapter (root law), and re-resuming an open mission
//    would violate C7's precondition.
//  * REDELIVERY CONVERGES: the intent re-cid's its phases (`cid:park`,
//    `cid:resume`) so a double-tap replays the same ledger entries; an
//    already-parked current window converges via park's own idempotence,
//    an already-resumed target via C7's open-check.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import { switcherOrder } from '@/domain/lifecycle/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { missionNameOf, missionStateOf, readMission } from './shared/rows.js';

const SWITCH_OP = 'command:SwitchMission';

/** One switcher row (the domain order's output, surface-shaped). */
export interface SwitcherItem {
  readonly missionId: string;
  readonly name: string;
  readonly cls: 'open' | 'parked';
  readonly tabCount: number;
  readonly lastActiveAt: number;
  /** Chrome window binding while open (the host's focus coordinate). */
  readonly windowId: number | null;
}

export type SwitchOutcome =
  | {
      readonly outcome: 'switched';
      readonly parked: boolean;
      readonly keptCount: number;
      readonly windowId: number;
      readonly restored: number;
      readonly moved: number;
    }
  | {
      readonly outcome: 'focus-window';
      readonly parked: boolean;
      readonly keptCount: number;
      readonly windowId: number | null;
    };

/** The chain seams (composition wires the flagship park/resume services; the
 *  use-case never reaches adapters itself — root law). */
export interface SwitcherSeams {
  readonly parkWindow: (
    input: { readonly windowId: number },
    ctx: UseCtx,
  ) => Promise<Result<{ readonly missionId: string; readonly keptCount: number }, LedgeError>>;
  readonly resumeMission: (
    input: { readonly missionId: string; readonly mode: 'full' | 'partial' },
    ctx: UseCtx,
  ) => Promise<
    Result<
      { readonly windowId: number; readonly restored: number; readonly moved: number },
      LedgeError
    >
  >;
}

export interface SwitcherService {
  /** The W8 list (open-first, parked-next; reads never act). */
  listSwitcher(ctx: UseCtx): Promise<Result<readonly SwitcherItem[], LedgeError>>;
  /** C28: the single intent — optional park-current, then switch target. */
  switchMission(
    input: {
      readonly targetMissionId: string;
      readonly parkCurrent: boolean;
      readonly sourceWindowId?: number | undefined;
    },
    ctx: UseCtx,
  ): Promise<Result<SwitchOutcome, LedgeError>>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const itemOf = (row: StoredRecord): SwitcherItem | null => {
  const missionId = str(row['missionId']);
  if (missionId.length === 0) return null;
  const state = missionStateOf(row);
  const cls =
    state === 'live' ? 'open' : state === 'parked' || state === 'archived' ? 'parked' : null;
  if (cls === null) return null;
  const tabIds = row['tabIds'];
  const binding = row['windowBinding'];
  return {
    missionId,
    name: missionNameOf(row),
    cls,
    tabCount: Array.isArray(tabIds) ? tabIds.length : 0,
    lastActiveAt: num(row['lastActiveAt']) ?? 0,
    windowId: typeof binding === 'number' ? binding : null,
  };
};

export const createSwitcherService = (edge: ServiceEdge, seams: SwitcherSeams): SwitcherService => {
  const { deps } = edge;

  return {
    listSwitcher: async (ctx) => {
      ctx.token.throwIfCancelled();
      // Index-covered reads only (schema v1 missions.state) — one per class
      // the switcher can ever show (trash is never read: never offered).
      const buckets = await Promise.all(
        (['live', 'parked', 'archived'] as const).map((state) =>
          deps.engine.txn(['missions'], 'readonly', async (tx) =>
            tx
              .table<StoredRecord>('missions')
              .byIndex({ kind: 'equals', name: 'state', value: state }),
          ),
        ),
      );
      for (const b of buckets) if (!b.ok) return err(b.error);
      const rows = buckets.flatMap((b) => (b.ok ? (b.value as readonly StoredRecord[]) : []));
      const inputs = rows
        .map((row) => ({
          missionId: str(row['missionId']),
          name: missionNameOf(row),
          state: missionStateOf(row),
          lastActiveAt: num(row['lastActiveAt']) ?? 0,
        }))
        .filter((m) => m.missionId.length > 0);
      const order = switcherOrder(inputs).map((m) => m.missionId);
      const byId = new Map(
        rows
          .map(itemOf)
          .filter((i): i is SwitcherItem => i !== null)
          .map((i) => [i.missionId, i]),
      );
      return ok(order.map((id) => byId.get(id)).filter((i): i is SwitcherItem => i !== undefined));
    },

    switchMission: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.targetMissionId.trim().length === 0) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: SWITCH_OP, reason: 'target-empty' }),
        );
      }
      // The park phase needs a NAMED window: "park current" without the
      // source coordinate is a malformed door, answered calmly up front.
      if (input.parkCurrent && typeof input.sourceWindowId !== 'number') {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: SWITCH_OP,
            reason: 'source-window-required',
          }),
        );
      }
      const targetR = await readMission(deps.engine, input.targetMissionId);
      if (!targetR.ok) return err(targetR.error);
      // missionStateOf defaults an ABSENT row to 'live' (forward tolerance §2.9)
      // — for a switch target that would lie, so absence is checked FIRST.
      if (targetR.value === undefined) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: SWITCH_OP, reason: 'target-gone' }),
        );
      }
      const targetState = missionStateOf(targetR.value);
      if (targetState !== 'live' && targetState !== 'parked' && targetState !== 'archived') {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: SWITCH_OP, reason: 'target-gone' }),
        );
      }
      // PHASE 1 — park current (C5). Failure ABORTS: the switch never runs
      // and the current context stands (W8's failure law, verbatim).
      let parked = false;
      let keptCount = 0;
      if (input.parkCurrent && typeof input.sourceWindowId === 'number') {
        const parkR = await seams.parkWindow(
          { windowId: input.sourceWindowId },
          { ...ctx, cid: `${ctx.cid}:park` },
        );
        if (!parkR.ok) {
          // Abort with the ORIGINAL fault code (an IO failure is not a
          // legality answer); the phase detail says the switch never ran.
          return err({
            ...parkR.error,
            details: { ...parkR.error.details, phase: 'park', aborted: true },
          });
        }
        parked = true;
        keptCount = parkR.value.keptCount;
      }
      // PHASE 2 — switch (C7 for parked targets; a truth answer for open).
      ctx.token.throwIfCancelled(); // last checkpoint before the context leaps
      if (targetState === 'live') {
        const binding = num(targetR.value?.['windowBinding']);
        return ok({
          outcome: 'focus-window',
          parked,
          keptCount,
          windowId: binding ?? null,
        });
      }
      const resumeR = await seams.resumeMission(
        { missionId: input.targetMissionId, mode: 'full' },
        { ...ctx, cid: `${ctx.cid}:resume` },
      );
      if (!resumeR.ok) {
        // Honest partial: the park landed (context safe + undoable); the
        // error names the phase so the surface can say exactly what stands.
        return err({
          ...resumeR.error,
          details: { ...resumeR.error.details, phase: 'resume', parked },
        });
      }
      return ok({
        outcome: 'switched',
        parked,
        keptCount,
        windowId: resumeR.value.windowId,
        restored: resumeR.value.restored,
        moved: resumeR.value.moved,
      });
    },
  };
};
