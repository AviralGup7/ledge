// E3-APP · Resume/restore use-case service (C7 ResumeMission · C8
// RestoreRecentlyClosed). §6.5 sequence: legality (domain) → ResumeAccepted/Restore-
// Accepted durable BEFORE the browser move → windows/tabs.create (ordered; group styling
// is the TabGroupsPort adr-noted tier) → MissionResumed with the ACTUAL mapping →
// projection drive. Resend law per C7 (idempotent by mission open-check: a mission
// already live replays the response shape without re-creating windows).
import { decideResume } from '@/domain/lifecycle/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import { missionStateOf, missionTabIdsOf, readMission, readTab } from './shared/rows.js';
import type { PlannedPlan } from './shared/stream-appender.js';

const RESUME_OP = 'command:resume';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Restored-tab mapping entry (rides MissionResumed.restoredMapping.tabs). */
interface RestoredTab {
  readonly tabId: string;
  readonly url: string;
}

export interface ResumeOutcome {
  readonly windowId: number;
  readonly restored: number;
  readonly moved: number;
}

export interface ResumeService {
  resumeMission(
    input: {
      readonly missionId: string;
      readonly mode: 'full' | 'partial';
      readonly tabIds?: readonly string[] | undefined;
    },
    ctx: UseCtx,
  ): Promise<Result<ResumeOutcome, LedgeError>>;
  restoreRecentlyClosed(
    input: { readonly ids: readonly string[]; readonly target: string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly restored: number }, LedgeError>>;
}

export const createResumeService = (edge: ServiceEdge): ResumeService => {
  const { deps, appender } = edge;

  /** Read the restorable content of one tab record (KEPT rows carry urls). */
  const restorableOf = async (tabId: string): Promise<Result<RestoredTab | null, LedgeError>> => {
    const rowR = await readTab(deps.engine, tabId);
    if (!rowR.ok) return err(rowR.error);
    if (rowR.value === undefined) return ok(null);
    const url = str(rowR.value['url']);
    if (url.length === 0) return ok(null);
    return ok({ tabId, url });
  };

  /** Browser execution + terminal stamp for one accepted restore act. */
  const executeRestore = async (
    commandFamily: string,
    cid: string,
    missionId: string,
    mode: 'full' | 'partial',
    plans: readonly RestoredTab[],
    ctx: UseCtx,
    acceptEnvelope: PlannedPlan,
  ): Promise<Result<ResumeOutcome, LedgeError>> => {
    // Durable accept BEFORE the browser move (§6.5; resend-safe per C7).
    const accepted = await appender.commit({
      plans: [acceptEnvelope],
      key: opKey(edge, `${commandFamily}:accept`, cid),
    });
    if (!accepted.ok) return err(accepted.error);
    ctx.notifyPending(`${commandFamily}:${missionId}`);
    ctx.token.throwIfCancelled();

    ctx.progress({ stage: 2 });
    const created = await deps.windows.create({
      tabSpecs: plans.map((t) => ({ url: t.url })),
      focused: true,
    });
    if (!created.ok) return err(created.error);
    const windowId = created.value;

    // Live coordinates: the port returns the window id; per-tab browser ids are
    // queried back (create returns only the window — tab ids arrive via query).
    ctx.progress({ stage: 3 });
    const tabsNow = await deps.tabs.query({ windowId });
    const browserIds = tabsNow.ok ? tabsNow.value.map((t) => t.browserTabId) : [];
    const mapping = {
      windowId,
      tabs: plans.map((t, i) => ({
        tabId: t.tabId,
        ...(browserIds[i] !== undefined ? { browserTabId: browserIds[i] } : {}),
      })),
    };
    const completed = await appender.commit({
      plans: [
        {
          type: 'MissionResumed',
          payload: { missionId, mode, restoredMapping: mapping },
        },
      ],
      key: opKey(edge, `${commandFamily}:complete`, cid),
    });
    if (!completed.ok) return err(completed.error);
    ctx.progress({ stage: 4 });
    // moved: dupe-aware restore (an already-open tab re-homed instead of recreated)
    // is the dupe_index tier — v1 reports the honest zero, adr-noted.
    return ok({ windowId, restored: plans.length, moved: 0 });
  };

  return {
    resumeMission: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      ctx.progress({ stage: 1 });
      const rowR = await readMission(deps.engine, input.missionId);
      if (!rowR.ok) return err(rowR.error);
      const row = rowR.value;
      if (row === undefined)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: RESUME_OP, reason: 'mission-missing' }),
        );
      const state = missionStateOf(row);
      if (state === 'live') {
        // C7 open-check idempotency: an already-live mission answers, never re-opens.
        const binding = typeof row['windowBinding'] === 'number' ? row['windowBinding'] : 0;
        return ok({ windowId: binding, restored: 0, moved: 0 });
      }
      const memberIds = missionTabIdsOf(row);
      const decision = decideResume({
        missionId: input.missionId,
        state,
        mode: input.mode,
        ...(input.tabIds !== undefined ? { tabIds: input.tabIds } : {}),
        memberTabIds: memberIds,
      });
      if (!decision.allowed)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: RESUME_OP, reason: decision.reason }),
        );
      const selection =
        input.mode === 'full'
          ? memberIds
          : (input.tabIds ?? []).filter((t) => memberIds.includes(t));
      const plans: RestoredTab[] = [];
      for (const tabId of selection) {
        const content = await restorableOf(tabId);
        if (!content.ok) return err(content.error);
        if (content.value !== null) plans.push(content.value);
      }
      const acceptEvent = decision.events[0];
      if (acceptEvent === undefined)
        return err(ledgeError('E_CAPABILITY', { operation: RESUME_OP, fault: 'accept-plan' }));
      return executeRestore('ResumeMission', ctx.cid, input.missionId, input.mode, plans, ctx, {
        type: acceptEvent.type,
        payload: acceptEvent.payload,
      });
    },

    restoreRecentlyClosed: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      // Content law (v1): only entries whose TAB RECORD survived with content can
      // reopen — externally-closed rows leave no tabs rows (their snapshot content
      // enrichment is the recently-closed projector's adr-noted growth).
      const plans: RestoredTab[] = [];
      for (const tabId of input.ids) {
        const content = await restorableOf(tabId);
        if (!content.ok) return err(content.error);
        if (content.value !== null) plans.push(content.value);
      }
      if (plans.length === 0) {
        return ok({ restored: 0 });
      }
      let missionId: string;
      if (input.target === 'new') {
        missionId = deps.ids.nextId();
      } else {
        const rowR = await readMission(deps.engine, input.target);
        if (!rowR.ok) return err(rowR.error);
        if (rowR.value === undefined)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', {
              operation: 'command:RestoreRecentlyClosed',
              reason: 'destination-missing',
            }),
          );
        missionId = input.target;
      }
      const acceptPlans: PlannedPlan[] = [
        ...(input.target === 'new'
          ? [
              {
                type: 'MissionFormed',
                payload: {
                  missionId,
                  name: 'Restored session',
                  namedBy: 'system',
                  tabIds: plans.map((t) => t.tabId),
                  provenance: 'restore',
                },
              },
            ]
          : []),
        {
          type: 'RestoreAccepted',
          payload: {
            missionId,
            mode: 'partial',
            restoredMapping: { plannedTabIds: plans.map((t) => t.tabId) },
          },
        },
      ];
      const accepted = await appender.commit({
        plans: acceptPlans,
        key: opKey(edge, 'RestoreRecentlyClosed:accept', ctx.cid),
      });
      if (!accepted.ok) return err(accepted.error);
      ctx.notifyPending(`RestoreRecentlyClosed:${missionId}`);
      ctx.token.throwIfCancelled();

      const created = await deps.windows.create({
        tabSpecs: plans.map((t) => ({ url: t.url })),
        focused: true,
      });
      if (!created.ok) return err(created.error);
      const windowId = created.value;
      const tabsNow = await deps.tabs.query({ windowId });
      const browserIds = tabsNow.ok ? tabsNow.value.map((t) => t.browserTabId) : [];
      const completed = await appender.commit({
        plans: [
          {
            type: 'MissionResumed',
            payload: {
              missionId,
              mode: 'partial',
              restoredMapping: {
                windowId,
                tabs: plans.map((t, i) => ({
                  tabId: t.tabId,
                  ...(browserIds[i] !== undefined ? { browserTabId: browserIds[i] } : {}),
                })),
              },
            },
          },
        ],
        key: opKey(edge, 'RestoreRecentlyClosed:complete', ctx.cid),
      });
      if (!completed.ok) return err(completed.error);
      return ok({ restored: plans.length });
    },
  };
};
