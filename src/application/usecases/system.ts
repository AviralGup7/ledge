// E3-APP · System/policy service (C1 FirstRunIngest · C19 SetSetting · C23
// RepairRebuild · C24 RescueScanNow · C25 ForgetEverything · C26 ExportDiagnostics).
// Scope law (v1): durability/rebuild/scan flows compose EXISTING truth-engine ports;
// C25 purges DERIVED stores only (memory_artifacts + search_index + dupe_index) — the
// spec law "tabs untouched", journal truth untouched — audited by MemoryWiped.
// Settings are ADR-035 LWW rows (NOT journal truth); SettingsChanged is the §4
// fan-out hint, journaled as the signal its registry row declares.
import { ledgeError, err, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import { readMeta } from './shared/rows.js';
import type { PlannedPlan } from './shared/stream-appender.js';

const SYS_OP = 'command:system';

/** C19 v1 settings whitelist (closed set; growth = schema-versioned keys via spec). */
const SETTINGS_WHITELIST: readonly string[] = [
  'trash.retentionDays',
  'trash.bulkConfirmThreshold',
  'undo.stackCap',
  'park.allWindowMs',
  'heartbeat.windowMs',
  'recentlyClosed.retentionDays',
];

/** Per-entity favorite/pin carriers are key-namespaced (`favorite.mission.<id>`). */
const SETTINGS_PREFIX_WHITELIST: readonly string[] = ['favorite.', 'pinnedMission.'];

/** logs ring row (§5 logs ring 500; diagnostics/dossiers land here). */
const LOGS_PREFIX = 'diag';
const LOG_RING_SLOTS = 500;
/** C24 rate law: full journal scans pace ≥7d apart (tail scans are unthrottled —
 *  their ≤50ms law makes them polite by construction). */
const DAYS_PER_WEEK = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;
export const FULL_SCAN_MIN_GAP_MS =
  DAYS_PER_WEEK * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
export const META_LAST_FULL_SCAN = 'diag.lastFullScanAt';

const isPrimitive = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

export interface SystemService {
  firstRunIngest(
    ctx: UseCtx,
  ): Promise<
    Result<{ readonly missionsCreated: number; readonly tabsCaptured: number }, LedgeError>
  >;
  setSetting(
    input: { readonly key: string; readonly value: unknown },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
  repairRebuild(
    input: { readonly scope: 'all' | string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly rebuilt: readonly string[] }, LedgeError>>;
  rescueScanNow(
    input: {
      readonly mode: 'tail' | 'full';
      /** E6-T06 F1: cadence override flag (payload-verbatim; honored ONLY with
       *  consoleAuthorized — the capability itself derives from the validated
       *  envelope, never from a flag a client can claim). */
      readonly force?: true | undefined;
      /** Rescue-console capability as decided by the handler from the envelope. */
      readonly consoleAuthorized: boolean;
    },
    ctx: UseCtx,
  ): Promise<Result<{ readonly reportId: string }, LedgeError>>;
  forgetEverything(
    input: { readonly confirm: boolean },
    ctx: UseCtx,
  ): Promise<Result<{ readonly artifactsPurged: number }, LedgeError>>;
  exportDiagnostics(
    input: { readonly includeAddresses?: boolean | undefined },
    ctx: UseCtx,
  ): Promise<Result<{ readonly bundleId: string }, LedgeError>>;
}

export const createSystemService = (edge: ServiceEdge): SystemService => {
  const { deps, appender } = edge;

  // E6-T03: the reports path prefers the unified diagnostics ring (typed rows,
  // redacted fields, fail-drop law). The legacy inline ring write survives as the
  // degrade path when the seam is unwired (never a fault, by diagnostics law).
  const reportDiag = async (
    kind: 'scan' | 'bundle',
    msg: string,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<Result<string, LedgeError>> => {
    if (deps.diagnostics !== undefined) {
      return deps.diagnostics.report(kind, { level: 'info', msg, fields });
    }
    const reportId = `${LOGS_PREFIX}.${kind}:${String(deps.now())}:${deps.ids.nextId()}`;
    const written = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
      const row = await tx.table('meta').get('logs.slot');
      const slot = typeof row?.['value'] === 'number' ? row['value'] : 0;
      const next = (slot + 1) % LOG_RING_SLOTS;
      await tx.table('meta').put({ key: 'logs.slot', value: next });
      return slot;
    });
    if (!written.ok) return err(written.error);
    const put = await deps.engine.txn(['logs'], 'readwrite', async (tx) => {
      await tx.table('logs').put({ slot: written.value, kind, msg, ...fields });
    });
    if (!put.ok) return err(put.error);
    return ok(reportId);
  };

  return {
    firstRunIngest: async (ctx) => {
      ctx.token.throwIfCancelled();
      if (deps.ingest === undefined)
        return err(ledgeError('E_CAPABILITY', { operation: SYS_OP, fault: 'ingest-not-wired' }));
      ctx.progress({ stage: 1 });
      const live = await deps.tabs.query({});
      if (!live.ok) return err(live.error);
      const crawl = await deps.ingest.firstRunIngest(live.value);
      if (!crawl.ok) return err(crawl.error);
      const report = crawl.value;
      if (!report.applied || report.idempotentSkip) {
        return ok({ missionsCreated: 0, tabsCaptured: report.tabsCaptured });
      }
      ctx.progress({ stage: 2 });
      // W1: one mission per window, named from its active tab's domain (the ledger
      // ids ride the crawl's TabObserveds → tabs rows, read back post-projection).
      const tabsRows = await deps.engine.txn(['tabs'], 'readonly', async (tx) =>
        tx.table('tabs').byIndex({ kind: 'equals', name: 'state', value: 'live' }),
      );
      if (!tabsRows.ok) return err(tabsRows.error);
      const byWindow = new Map<number, { active: string; readonly ids: string[] }>();
      for (const row of tabsRows.value) {
        const w = row['windowId'];
        const id = row['ledgeTabId'];
        if (typeof w !== 'number' || typeof id !== 'string') continue;
        const entry = byWindow.get(w) ?? { active: '', ids: [] };
        entry.ids.push(id);
        const liveTab = live.value.find((x) => x.browserTabId === row['browserTabId']);
        if (liveTab?.active === true) entry.active = strOf(row['domain']);
        byWindow.set(w, entry);
      }
      const plans: PlannedPlan[] = [];
      for (const w of byWindow.values()) {
        if (w.ids.length === 0) continue;
        plans.push({
          type: 'MissionFormed',
          payload: {
            missionId: deps.ids.nextId(),
            name: w.active.length > 0 ? w.active : 'First window',
            namedBy: 'system',
            tabIds: [...w.ids],
            provenance: 'first-run',
          },
        });
      }
      if (plans.length > 0) {
        const committed = await appender.commit({
          plans,
          key: opKey(edge, 'FirstRunIngest', ctx.cid),
        });
        if (!committed.ok) return err(committed.error);
      }
      ctx.progress({ stage: 3 });
      return ok({ missionsCreated: plans.length, tabsCaptured: report.tabsCaptured });
    },

    setSetting: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const allowed =
        SETTINGS_WHITELIST.includes(input.key) ||
        SETTINGS_PREFIX_WHITELIST.some((p) => input.key.startsWith(p));
      if (!allowed || !isPrimitive(input.value)) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'command:SetSetting',
            reason: 'key-not-whitelisted',
          }),
        );
      }
      const written = await deps.engine.txn(['settings'], 'readwrite', async (tx) => {
        const existing = await tx.table('settings').get(input.key);
        const schemaV = typeof existing?.['schemaV'] === 'number' ? existing['schemaV'] : 1;
        await tx
          .table('settings')
          .put({ key: input.key, value: input.value, schemaV, updatedAt: deps.now() });
        return schemaV;
      });
      if (!written.ok) return err(written.error);
      // §4 fan-out hint (ADR-035: the ROW above is truth; this event is the signal).
      const committed = await appender.commit({
        plans: [
          {
            type: 'SettingsChanged',
            payload: { key: input.key, value: input.value, schemaV: written.value },
          },
        ],
        key: opKey(edge, 'SetSetting', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({});
    },

    repairRebuild: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const views =
        input.scope === 'all'
          ? (['missions', 'recentlyClosed', 'sessions', 'tabs'] as const)
          : [input.scope as 'missions' | 'recentlyClosed' | 'sessions' | 'tabs'];
      const rebuilt: string[] = [];
      const plans: PlannedPlan[] = [];
      for (const view of views) {
        ctx.token.throwIfCancelled();
        const startedAt = deps.now();
        const r = await deps.projections.rebuild(view);
        if (!r.ok) return err(r.error);
        rebuilt.push(view);
        plans.push({
          type: 'ProjectionRebuilt',
          payload: {
            projectorId: view,
            toWatermark: r.value.eventsApplied,
            durationMs: Math.max(0, deps.now() - startedAt),
          },
        });
      }
      if (plans.length > 0) {
        const committed = await appender.commit({
          plans,
          key: opKey(edge, 'RepairRebuild', ctx.cid),
        });
        if (!committed.ok) return err(committed.error);
      }
      return ok({ rebuilt });
    },

    rescueScanNow: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      // C24 cadence law (user-ruled F1, capability-authorized force): a full scan
      // <7d after the last refuses E_DOMAIN_LEGALITY 'full-scan-cadence'; force
      // overrides ONLY for the rescue-console capability (envelope-derived — a
      // client cannot self-declare), else 'force-unauthorized'. Both refusals
      // land before any journal work; the stamp rides only a SUCCESSFUL scan.
      if (input.mode === 'full') {
        const last = await readMeta(deps.engine, META_LAST_FULL_SCAN);
        if (!last.ok) return err(last.error);
        const lastAt = typeof last.value === 'number' ? last.value : null;
        if (lastAt !== null && deps.now() - lastAt < FULL_SCAN_MIN_GAP_MS) {
          if (input.force !== true)
            return err(
              ledgeError('E_DOMAIN_LEGALITY', {
                operation: 'command:RescueScanNow',
                reason: 'full-scan-cadence',
                nextEligibleAt: lastAt + FULL_SCAN_MIN_GAP_MS,
              }),
            );
          if (!input.consoleAuthorized)
            return err(
              ledgeError('E_DOMAIN_LEGALITY', {
                operation: 'command:RescueScanNow',
                reason: 'force-unauthorized',
              }),
            );
        }
      }
      const scan =
        input.mode === 'tail' ? await deps.journal.scanTail() : await deps.journal.scanFull();
      if (!scan.ok) return err(scan.error);
      if (input.mode === 'full') {
        const stamped = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
          await tx.table('meta').put({ key: META_LAST_FULL_SCAN, value: deps.now() });
        });
        if (!stamped.ok) return err(stamped.error);
      }
      // The unified ring carries the scan receipt (audit trail — a FORCED scan
      // is exactly the row an operator wants findable, user-ruled F1/F4).
      const rid = await reportDiag('scan', `scan-${input.mode}`, {
        mode: input.mode,
        status: scan.value.status,
        coverage: scan.value.coverage,
        suspects: scan.value.suspects.length,
        forced: input.force === true,
        at: deps.now(),
      });
      if (!rid.ok) return err(rid.error);
      return ok({ reportId: rid.value });
    },

    forgetEverything: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.confirm !== true) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'command:ForgetEverything',
            reason: 'confirm-exact-required',
          }),
        );
      }
      // Spec law: TABS UNTOUCHED; derived stores only, in one bounded sweep.
      const counts = await deps.engine.txn(
        ['memory_artifacts', 'search_index', 'dupe_index'],
        'readwrite',
        async (tx) => {
          const artifacts = await tx.table('memory_artifacts').toArray();
          let n = 0;
          for (const row of artifacts) {
            const key = row['artifactId'];
            if (typeof key === 'string') {
              await tx.table('memory_artifacts').delete(key);
              n += 1;
            }
          }
          for (const row of await tx.table('search_index').toArray()) {
            const key = row['token'];
            if (typeof key === 'string') await tx.table('search_index').delete(key);
          }
          for (const row of await tx.table('dupe_index').toArray()) {
            const key = row['canonHash'];
            if (typeof key === 'string') await tx.table('dupe_index').delete(key);
          }
          return n;
        },
      );
      if (!counts.ok) return err(counts.error);
      const committed = await appender.commit({
        plans: [
          {
            type: 'MemoryWiped',
            payload: { purgedCount: counts.value, wipeId: deps.ids.nextId() },
          },
        ],
        key: opKey(edge, 'ForgetEverything', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({ artifactsPurged: counts.value });
    },

    exportDiagnostics: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      // E6-T05: with the diagnostics seam wired, the adapter assembles the bundle
      // (probe-registry dump, projections status, tail scan, quota, ring tail —
      // redaction posture = current flip). includeAddresses:true GRANTS the 24h
      // flip (ADR-027); without the seam the legacy ad-hoc dossier stands.
      if (deps.diagnostics !== undefined) {
        if (input.includeAddresses === true) {
          const granted = await deps.diagnostics.grantIncludeAddresses(true);
          if (!granted.ok) return err(granted.error);
        }
        const bundle = await deps.diagnostics.exportBundle();
        if (!bundle.ok) return err(bundle.error);
        return ok({ bundleId: bundle.value.bundleId });
      }
      const status = await deps.projections.status();
      if (!status.ok) return err(status.error);
      const scan = await deps.journal.scanTail();
      const quota = await deps.engine.quota();
      const body: Record<string, unknown> = {
        at: deps.now(),
        includeAddresses: input.includeAddresses === true,
        projections: status.value.views.map((v) => ({
          view: v.view,
          dirty: v.dirty,
          projectorV: v.projectorV,
        })),
        journalTailScan: scan.ok ? { status: scan.value.status } : { status: 'error' },
        storage: quota.ok ? { persisted: quota.value.persisted } : { persisted: false },
      };
      // Legacy degrade path (diagnostics seam unwired): the pre-T03 dossier row.
      const rid = await reportDiag('bundle', 'bundle-legacy', {
        at: typeof body['at'] === 'number' ? body['at'] : deps.now(),
        includeAddresses: input.includeAddresses === true,
        projections: Array.isArray(body['projections']) ? body['projections'].length : 0,
      });
      if (!rid.ok) return err(rid.error);
      return ok({ bundleId: rid.value });
    },
  };
};

const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');
