// E3-APP · Park use-case service (C3 ParkTab · C4 ParkGroup · C5 ParkWindow · C6
// ParkAll) — the flagship two-phase write family (ADR-011, §6.4, W4).
// Sequence law per scope: snapshot build FIRST (invariant i; W4 "a park that can't be
// guaranteed never proceeds") → decider admit → accept (SnapshotTaken + formation +
// ParkIntentAccepted + intent row + snapshot part rows in ONE txn — §6.4 txn A via the
// ledger caller hinge) → notifyPending (§3.5 CommandAck) → browser close (only after
// durable ack) → complete/abort (TabsParked|ParkAborted) → projection drive.
// Cancellation checkpoints exist BEFORE the browser mutation and never after: once
// closes were paid for, the terminal MUST land (complete or abort) — a stranded paid
// park is strictly worse than an uncancellable one.
import { decideParkPlan, policyOf } from '@/domain/lifecycle/index.js';
import type { GroupStyle } from '@/application/ports/snapshots.port.js';
import type { Id } from '@/shared-kernel/identity/id.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import {
  missionStateOf,
  readLiveTabs,
  readMeta,
  readMission,
  readSettingsRows,
} from './shared/rows.js';
import type { PlannedPlan } from './shared/stream-appender.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';

const PARK_OP = 'command:park';
/** ParkAll rate stamp (C6: 1/min-class durable; SW-restarts cannot accelerate it). */
const META_PARK_ALL_STAMP = 'parkAll.lastAt';
const PARKALL_STAGE_BASE = 10;

/** One live tab resolved for a park scope (coordinates from the tabs row). */
interface ScopeTab {
  readonly ledgeTabId: string;
  readonly browserTabId: number;
  readonly missionId: string;
  readonly domain: string;
  readonly windowId?: number | undefined;
  readonly groupId?: number | null | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const scopeTabOf = (row: StoredRecord): ScopeTab | null => {
  const ledgeTabId = str(row['ledgeTabId']);
  const browserTabId = num(row['browserTabId']);
  if (ledgeTabId.length === 0 || browserTabId === undefined) return null;
  const groupId = row['groupId'];
  return {
    ledgeTabId,
    browserTabId,
    missionId: str(row['missionId']),
    domain: str(row['domain']),
    ...(num(row['windowId']) !== undefined ? { windowId: num(row['windowId']) } : {}),
    ...(typeof groupId === 'number' || groupId === null ? { groupId } : {}),
  };
};

export interface ParkOutcome {
  readonly missionId: string;
  readonly keptCount: number;
}

export interface ParkService {
  parkTab(
    input: { readonly browserTabId: number },
    ctx: UseCtx,
  ): Promise<Result<{ readonly kept: string }, LedgeError>>;
  parkGroup(
    input: { readonly groupId: number },
    ctx: UseCtx,
  ): Promise<Result<ParkOutcome, LedgeError>>;
  parkWindow(
    input: { readonly windowId: number },
    ctx: UseCtx,
  ): Promise<Result<ParkOutcome & { readonly briefQueued: boolean }, LedgeError>>;
  parkAll(
    input: { readonly exceptWindowId?: number | undefined },
    ctx: UseCtx,
  ): Promise<Result<{ readonly missions: number; readonly keptCount: number }, LedgeError>>;
}

export const createParkService = (edge: ServiceEdge): ParkService => {
  const { deps, appender } = edge;

  const liveInventory = async (): Promise<Result<readonly ScopeTab[], LedgeError>> => {
    const rows = await readLiveTabs(deps.engine);
    if (!rows.ok) return err(rows.error);
    return ok(rows.value.map(scopeTabOf).filter((t): t is ScopeTab => t !== null));
  };

  /**
   * Target law (v1, recorded in docs/adr-notes/e3-app-layer.md): a scope parks into
   * the mission its tabs already belong to (majority non-empty binding); otherwise a
   * mission is FORMED (provenance 'park', system-named from the leading domain).
   */
  const resolveTarget = async (
    scope: readonly ScopeTab[],
  ): Promise<
    Result<
      | { readonly kind: 'bound'; readonly missionId: string }
      | { readonly kind: 'form'; readonly missionId: string; readonly name: string },
      LedgeError
    >
  > => {
    const counts = new Map<string, number>();
    for (const t of scope) {
      if (t.missionId.length > 0) counts.set(t.missionId, (counts.get(t.missionId) ?? 0) + 1);
    }
    const bound = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (bound !== undefined) {
      const rowR = await readMission(deps.engine, bound[0]);
      if (!rowR.ok) return err(rowR.error);
      if (rowR.value !== undefined && missionStateOf(rowR.value) !== 'trash') {
        return ok({ kind: 'bound', missionId: bound[0] });
      }
    }
    const name = scope.map((t) => t.domain).find((d) => d.length > 0) ?? 'Parked mission';
    return ok({ kind: 'form', missionId: deps.ids.nextId(), name });
  };

  /** The whole two-phase act for one resolved scope. */
  const parkScope = async (
    kind: string,
    scope: readonly ScopeTab[],
    groupStyles: readonly GroupStyle[],
    ctx: UseCtx,
  ): Promise<Result<ParkOutcome, LedgeError>> => {
    ctx.token.throwIfCancelled();
    if (scope.length === 0)
      return err(
        ledgeError('E_DOMAIN_LEGALITY', { operation: PARK_OP, reason: 'park-empty-scope' }),
      );
    const target = await resolveTarget(scope);
    if (!target.ok) return err(target.error);
    const targetValue = target.value;
    const missionId = targetValue.missionId;
    const now = deps.now();

    // 1) W4 law: the snapshot is built (proven) BEFORE any intent rides.
    ctx.progress({ stage: 1 });
    const built = await deps.snapshots.build({
      missionId,
      tabRecordIds: scope.map((t) => t.ledgeTabId),
      groupStyles,
      takenAt: now,
      trigger: 'park',
    });
    if (!built.ok) return err(built.error); // never proceeds without guarantee

    // 2) Domain admit (invariant i re-verified at the seam).
    const intentId = deps.ids.nextId();
    const decision = decideParkPlan({
      tabIds: scope.map((t) => t.ledgeTabId),
      groupStyles,
      snapshotId: built.value.snapshotId,
      intentId,
      issuedAt: now,
    });
    if (!decision.allowed)
      return err(ledgeError('E_DOMAIN_LEGALITY', { operation: PARK_OP, reason: decision.reason }));

    // 3) §6.4 txn A: SnapshotTaken + formation + ParkIntentAccepted + intent row +
    //    snapshot part rows in ONE durable commit (ledger caller hinge).
    const scopeRecord = {
      missionId,
      tabIds: scope.map((t) => t.ledgeTabId),
      groupStyles: [...groupStyles],
      snapshotId: built.value.snapshotId,
    };
    const ackPlans: PlannedPlan[] = [
      { type: 'SnapshotTaken', payload: built.value.payload },
      ...(targetValue.kind === 'form'
        ? [
            {
              type: 'MissionFormed',
              payload: {
                missionId,
                name: targetValue.name,
                namedBy: 'system',
                tabIds: scope.map((t) => t.ledgeTabId),
                provenance: 'park',
              },
            },
          ]
        : []),
      {
        type: 'ParkIntentAccepted',
        payload: { intentId, scope: scopeRecord, issuedAt: now },
      },
    ];
    ctx.progress({ stage: 2 });
    const parts = built.value.parts;
    const accepted = await appender.withStampLock(async (stamp) => {
      const ackEvents = stamp(ackPlans);
      const a = await deps.ledger.accept({
        intentId: intentId as Id,
        cid: ctx.cid as Id,
        kind,
        scope: scopeRecord,
        issuedAt: now,
        ackEvents,
        extraStores: ['sessions'],
        hinge: async (tx) => {
          await tx.table('sessions').putMany(parts.map((p) => ({ ...p })));
        },
      });
      if (!a.ok) return err(a.error);
      if (a.value.deduped) {
        // Cross-restart cid resend: the durable original answers. A still-pending
        // original means the first execution is elsewhere/incomplete — refuse to
        // double-drive the browser (R2 honesty: one executor per intent).
        return err(
          ledgeError('E_CAPABILITY', { operation: PARK_OP, fault: 'intent-already-accepted' }),
        );
      }
      return ok({ value: undefined, committed: ackEvents });
    });
    if (!accepted.ok) return err(accepted.error);

    // 4) §3.5: CommandAck accepted-pending rides BEFORE the browser mutation.
    ctx.notifyPending(intentId);
    // Cancellation is checkpointed HERE — after this line the terminal must land.
    ctx.token.throwIfCancelled();

    // 5) Browser close (ONLY after durable ack — ADR-002 invariant a).
    ctx.progress({ stage: 3 });
    const closing = scope.map((t) => t.browserTabId);
    const removed = await deps.tabs.remove(closing);

    if (!removed.ok) {
      // Whole-executor failure: honest abort. details.removedIds (csv, port law)
      // approximates what closed before the failure for liveLeftOpen truth.
      const csv = removed.error.details?.['removedIds'];
      const closedKnown = typeof csv === 'string' && csv.length > 0 ? csv.split(',').length : 0;
      const abortOutcome = await appender.withStampLock(async (stamp) => {
        const events = stamp([
          {
            type: 'ParkAborted',
            payload: {
              intentId,
              reason: 'browser-remove-failed',
              liveLeftOpen: closing.length - closedKnown,
            },
          },
        ]);
        const a = await deps.ledger.abort(intentId as Id, events, deps.now());
        if (!a.ok) return err(a.error);
        return ok({ value: undefined, committed: events });
      });
      if (!abortOutcome.ok) return err(abortOutcome.error);
      await appender.applyProjections(abortOutcome.value.committed);
      return err(removed.error);
    }

    // 6) Completion: per-tab TabAssigned (THE kept stamp, R1) + TabsParked terminal.
    ctx.progress({ stage: 4 });
    const removedSet = new Set(removed.value);
    const securedTabs = scope.filter((t) => removedSet.has(t.browserTabId));
    const failedRefs = scope
      .filter((t) => !removedSet.has(t.browserTabId))
      .map((t) => ({ browserTabId: t.browserTabId, reason: 'not-closed' }));
    const completionPlans: PlannedPlan[] = [
      ...securedTabs.map((t) => ({
        type: 'TabAssigned',
        payload: { tabId: t.ledgeTabId, missionId },
      })),
      {
        type: 'TabsParked',
        payload: {
          intentId,
          secured: securedTabs.length,
          ...(failedRefs.length > 0 ? { failedRefs } : {}),
        },
      },
    ];
    const completed = await appender.withStampLock(async (stamp) => {
      const events = stamp(completionPlans);
      const c = await deps.ledger.complete(intentId as Id, events, deps.now());
      if (!c.ok) return err(c.error);
      return ok({ value: undefined, committed: events });
    });
    if (!completed.ok) return err(completed.error);
    await appender.applyProjections(completed.value.committed);
    ctx.progress({ stage: 5 });
    return ok({ missionId, keptCount: securedTabs.length });
  };

  const parkAllRateWindowMs = async (): Promise<number> => {
    const settings = await readSettingsRows(deps.engine);
    return policyOf(settings.ok ? settings.value : undefined).parkAllWindowMs;
  };

  return {
    parkTab: async (input, ctx) => {
      const live = await liveInventory();
      if (!live.ok) return err(live.error);
      const tab = live.value.find((t) => t.browserTabId === input.browserTabId);
      if (tab === undefined)
        return err(
          ledgeError('E_NOT_FOUND_TAB', { operation: 'command:ParkTab', id: input.browserTabId }),
        );
      const outcome = await parkScope('ParkTab', [tab], [], ctx);
      if (!outcome.ok) return err(outcome.error);
      return ok({ kept: tab.ledgeTabId });
    },

    parkGroup: async (input, ctx) => {
      const live = await liveInventory();
      if (!live.ok) return err(live.error);
      const members = live.value.filter((t) => t.groupId === input.groupId);
      if (members.length === 0)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'command:ParkGroup',
            reason: 'group-missing',
          }),
        );
      // EES-R4 style fidelity: what v1 can prove (member order by observed sequence);
      // the chrome tabGroups color/name join lands with the TabGroupsPort (adr-noted).
      const styles: GroupStyle[] = [
        {
          groupId: input.groupId,
          name: '',
          color: '',
          collapsed: false,
          tabOrder: members.map((t) => t.ledgeTabId),
        },
      ];
      return parkScope('ParkGroup', members, styles, ctx);
    },

    parkWindow: async (input, ctx) => {
      const live = await liveInventory();
      if (!live.ok) return err(live.error);
      const members = live.value.filter((t) => t.windowId === input.windowId);
      if (members.length === 0)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'command:ParkWindow',
            reason: 'window-missing-or-empty',
          }),
        );
      const outcome = await parkScope('ParkWindow', members, [], ctx);
      if (!outcome.ok) return err(outcome.error);
      // briefQueued: resumption-brief jobs are the Tier-3 AI queue's — always false v1.
      return ok({ ...outcome.value, briefQueued: false });
    },

    parkAll: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const stampR = await readMeta(deps.engine, META_PARK_ALL_STAMP);
      if (!stampR.ok) return err(stampR.error);
      const lastAt = typeof stampR.value === 'number' ? stampR.value : 0;
      const now = deps.now();
      const windowMs = await parkAllRateWindowMs();
      // C6 rate law (policy-carried): honest rate refusal, never a silent shed.
      if (lastAt !== 0 && now - lastAt < windowMs) {
        return err(ledgeError('E_RATE_LANESHED', { operation: 'command:ParkAll' }));
      }
      const live = await liveInventory();
      if (!live.ok) return err(live.error);
      const byWindow = new Map<number, ScopeTab[]>();
      for (const t of live.value) {
        if (t.windowId === undefined || t.windowId === input.exceptWindowId) continue;
        const list = byWindow.get(t.windowId) ?? [];
        list.push(t);
        byWindow.set(t.windowId, list);
      }
      if (byWindow.size === 0)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'command:ParkAll',
            reason: 'park-empty-scope',
          }),
        );
      let keptCount = 0;
      let index = 0;
      for (const members of byWindow.values()) {
        ctx.token.throwIfCancelled();
        ctx.progress({
          stage: PARKALL_STAGE_BASE + index,
          current: index + 1,
          total: byWindow.size,
        });
        const outcome = await parkScope('ParkAll', members, [], ctx);
        if (!outcome.ok) return err(outcome.error);
        keptCount += outcome.value.keptCount;
        index += 1;
      }
      // Rate stamp lands AFTER a fully successful sweep (a failed sweep never eats
      // the user's next window; durability hinge for the stamp is accept-side state
      // already inside the sweep's own intents).
      const stamped = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
        await tx.table('meta').put({ key: META_PARK_ALL_STAMP, value: now });
      });
      if (!stamped.ok) return err(stamped.error);
      return ok({ missions: byWindow.size, keptCount });
    },
  };
};
