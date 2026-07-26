// E3-APP · Query service — the read side (GetBootstrap · GetLibrary · GetMissionDetail
// · GetRecentlyClosed · GetTrash · SearchQuery · GetHealth · PeekOpenTabs + internal
// Recent Activity/History). Every read is index-covered (EES §2.9), every response is
// the DTO layer (display-free data; internal row fields stop at dto). SearchFallback
// law (§6.6 correctness law): when the search_index is empty/lagging the query
// degrades to a bounded keyword sweep over kept/live rows and SAYS SO (freshness
// 'fallback') — never a silently empty truth.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge } from './shared/app-ctx.js';
import type {
  ArtifactView,
  BootstrapView,
  HeartbeatView,
  LibraryPage,
  MissionDetailView,
  MissionView,
  OpenTabView,
  RecentlyClosedEntryView,
  SearchResultsView,
  TrashEntryView,
} from '@/application/dto/index.js';
import {
  artifactViewOf,
  missionViewOf,
  openTabViewOf,
  recentlyClosedViewOf,
  tabViewOf,
} from '@/application/dto/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { RecentlyClosedRow } from '@/application/ports/view-rows.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

/** §3 SearchQuery limit clamp (hub-side, contract note: bound ≤50). */
const SEARCH_LIMIT_CAP = 50;
const PAGE_SIZE_DEFAULT = 50;
/** E6-T04: timeline slice riding GetHealth (the console shows the freshest
 *  rows; the full ring dump rides the diagnostics bundle). */
const HEALTH_TIMELINE_ROWS = 25;

export interface QueryService {
  heartbeat(): Promise<Result<HeartbeatView, LedgeError>>;
  getBootstrap(input: { readonly surface: string }): Promise<Result<BootstrapView, LedgeError>>;
  getLibrary(input: {
    readonly filter?: unknown;
    readonly sort?: string | undefined;
    readonly cursor?: string | undefined;
  }): Promise<Result<LibraryPage, LedgeError>>;
  getMissionDetail(input: {
    readonly missionId: string;
  }): Promise<Result<MissionDetailView, LedgeError>>;
  getRecentlyClosed(input: { readonly cursor?: string | undefined }): Promise<
    Result<
      {
        readonly entries: readonly RecentlyClosedEntryView[];
        readonly nextCursor?: string | undefined;
      },
      LedgeError
    >
  >;
  getTrash(): Promise<Result<{ readonly entries: readonly TrashEntryView[] }, LedgeError>>;
  search(input: {
    readonly q: string;
    readonly scope?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<Result<SearchResultsView, LedgeError>>;
  getHealth(): Promise<Result<Readonly<Record<string, unknown>>, LedgeError>>;
  peekOpenTabs(input: {
    readonly windowId?: number | undefined;
  }): Promise<Result<readonly OpenTabView[], LedgeError>>;
  /** Internal Tier-2 (Recent Activity): kept/closed/trash merges, latest first. */
  getActivity(input?: {
    readonly limit?: number | undefined;
  }): Promise<Result<readonly TrashEntryView[], LedgeError>>;
}

export const createQueryService = (edge: ServiceEdge): QueryService => {
  const { deps } = edge;

  const tabsByState = async (state: string): Promise<Result<readonly StoredRecord[], LedgeError>> =>
    deps.engine.txn(['tabs'], 'readonly', async (tx) =>
      tx.table<StoredRecord>('tabs').byIndex({ kind: 'equals', name: 'state', value: state }),
    );

  const missionsByState = async (
    state: string,
  ): Promise<Result<readonly StoredRecord[], LedgeError>> =>
    deps.engine.txn(['missions'], 'readonly', async (tx) =>
      tx.table<StoredRecord>('missions').byIndex({ kind: 'equals', name: 'state', value: state }),
    );

  /** R10 heartbeat: KEPT rows count + LIVE recoverable rows count, post-Applied only. */
  const heartbeat = async (): Promise<Result<HeartbeatView, LedgeError>> => {
    const kept = await tabsByState('kept');
    if (!kept.ok) return err(kept.error);
    const live = await tabsByState('live');
    if (!live.ok) return err(live.error);
    return ok({
      keptCount: kept.value.length,
      liveRecoverable: live.value.length,
      asOf: deps.now(),
    });
  };

  const byActivityDesc = (a: StoredRecord, b: StoredRecord): number =>
    num(b['lastActiveAt']) - num(a['lastActiveAt']);

  const nonTrash = async (): Promise<Result<readonly StoredRecord[], LedgeError>> => {
    const settled = await Promise.all([
      missionsByState('live'),
      missionsByState('parked'),
      missionsByState('archived'),
    ]);
    const [live, parked, archived] = settled;
    if (!live.ok) return err(live.error);
    if (!parked.ok) return err(parked.error);
    if (!archived.ok) return err(archived.error);
    return ok([...live.value, ...parked.value, ...archived.value].sort(byActivityDesc));
  };

  return {
    heartbeat,

    getBootstrap: async (input) => {
      const library = await nonTrash();
      if (!library.ok) return err(library.error);
      const missions: MissionView[] = library.value
        .slice(0, PAGE_SIZE_DEFAULT)
        .map((r) => missionViewOf(r));
      const rcR = await deps.engine.txn(['recently_closed'], 'readonly', async (tx) =>
        tx.table<StoredRecord>('recently_closed').toArray(),
      );
      if (!rcR.ok) return err(rcR.error);
      const recentlyClosed = [...rcR.value]
        .sort((a, b) => num(b['closedAt']) - num(a['closedAt']))
        .slice(0, PAGE_SIZE_DEFAULT)
        .map((r) => recentlyClosedViewOf(r as unknown as RecentlyClosedRow));
      const trashTabs = await tabsByState('trash');
      if (!trashTabs.ok) return err(trashTabs.error);
      const trashMissions = await missionsByState('trash');
      if (!trashMissions.ok) return err(trashMissions.error);
      const settingsR = await deps.engine.txn(['settings'], 'readonly', async (tx) =>
        tx.table<StoredRecord>('settings').toArray(),
      );
      if (!settingsR.ok) return err(settingsR.error);
      const settings: Record<string, unknown> = {};
      for (const row of settingsR.value) {
        const key = row['key'];
        if (typeof key === 'string') settings[key] = row['value'];
      }
      const status = await deps.projections.status();
      if (!status.ok) return err(status.error);
      let watermark = 0;
      for (const view of status.value.views) {
        for (const wm of view.watermarks) watermark = Math.max(watermark, wm.seq);
      }
      const hb = await heartbeat();
      if (!hb.ok) return err(hb.error);
      void input.surface;
      return ok({
        missions,
        recentlyClosed,
        trashCount: trashTabs.value.length + trashMissions.value.length,
        watermark,
        settings,
        heartbeat: hb.value,
      });
    },

    getLibrary: async (input) => {
      // filter.states?: string[] (DTO tolerance); default the non-trash library.
      const f =
        typeof input.filter === 'object' && input.filter !== null
          ? (input.filter as Record<string, unknown>)
          : undefined;
      const statesWanted = Array.isArray(f?.['states'])
        ? (f['states'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      const rows: StoredRecord[] = [];
      if (statesWanted === undefined) {
        const all = await nonTrash();
        if (!all.ok) return err(all.error);
        rows.push(...all.value);
      } else {
        for (const state of statesWanted) {
          const part = await missionsByState(state);
          if (!part.ok) return err(part.error);
          rows.push(...part.value);
        }
        rows.sort(byActivityDesc);
      }
      // v1 cursor: numeric offset (cursor ≤24h validity is transport-level law).
      const offset =
        input.cursor !== undefined ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
      const page = rows.slice(offset, offset + PAGE_SIZE_DEFAULT);
      const nextOffset = offset + page.length;
      return ok({
        missions: page.map((r) => missionViewOf(r)),
        ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
      });
    },

    getMissionDetail: async (input) => {
      const rowR = await deps.engine.txn(['missions'], 'readonly', async (tx) =>
        tx.table<StoredRecord>('missions').get(input.missionId),
      );
      if (!rowR.ok) return err(rowR.error);
      if (rowR.value === undefined) {
        // Mission-not-found is a calm legality answer (closed catalog: no mission
        // flavor of not-found exists in v1 — adr-noted candidate for ADR-033 append).
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'query:GetMissionDetail',
            reason: 'mission-missing',
          }),
        );
      }
      const tabsR = await deps.engine.txn(['tabs'], 'readonly', async (tx) =>
        tx
          .table<StoredRecord>('tabs')
          .byIndex({ kind: 'equals', name: 'missionId', value: input.missionId }),
      );
      if (!tabsR.ok) return err(tabsR.error);
      const artifactsR = await deps.engine.txn(['memory_artifacts'], 'readonly', async (tx) =>
        tx
          .table<StoredRecord>('memory_artifacts')
          .byIndex({ kind: 'equals', name: '[subjectId+kind]', value: [input.missionId, 'topic'] }),
      );
      if (!artifactsR.ok) return err(artifactsR.error);
      const artifacts: ArtifactView[] = artifactsR.value.map((r) => artifactViewOf(r));
      return ok({
        mission: missionViewOf(rowR.value),
        tabs: tabsR.value.map((r) => tabViewOf(r)),
        artifacts,
      });
    },

    getRecentlyClosed: async (input) => {
      const rowsR = await deps.engine.txn(['recently_closed'], 'readonly', async (tx) =>
        tx.table<StoredRecord>('recently_closed').toArray(),
      );
      if (!rowsR.ok) return err(rowsR.error);
      const sorted = [...rowsR.value].sort((a, b) => num(b['closedAt']) - num(a['closedAt']));
      const offset =
        input.cursor !== undefined ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
      const page = sorted.slice(offset, offset + PAGE_SIZE_DEFAULT);
      const nextOffset = offset + page.length;
      return ok({
        entries: page.map((r) => recentlyClosedViewOf(r as unknown as RecentlyClosedRow)),
        ...(nextOffset < sorted.length ? { nextCursor: String(nextOffset) } : {}),
      });
    },

    getTrash: async () => {
      const tabs = await tabsByState('trash');
      if (!tabs.ok) return err(tabs.error);
      const missions = await missionsByState('trash');
      if (!missions.ok) return err(missions.error);
      const entries: TrashEntryView[] = [
        ...tabs.value.map((r) => ({
          kind: 'tab' as const,
          id: str(r['ledgeTabId']),
          deletedAt: num(r['deletedAt']),
          displayName: str(r['title']) || str(r['domain']),
          ...(str(r['missionId']).length > 0 ? { parentMissionId: str(r['missionId']) } : {}),
        })),
        ...missions.value.map((r) => ({
          kind: 'mission' as const,
          id: str(r['missionId']),
          deletedAt: num(r['deletedAt']),
          displayName: str(r['name']),
        })),
      ].sort((a, b) => b.deletedAt - a.deletedAt);
      return ok({ entries });
    },

    search: async (input) => {
      const limit = Math.min(Math.max(1, input.limit ?? SEARCH_LIMIT_CAP), SEARCH_LIMIT_CAP);
      const q = input.q.trim().toLowerCase();
      if (q.length === 0) {
        return ok({ results: [], freshness: 'fallback', searchedScopes: [] });
      }
      const scopeWanted = input.scope ?? 'all';
      const scopes: string[] = scopeWanted === 'all' ? ['open', 'kept', 'closed'] : [scopeWanted];
      const hits: {
        readonly tabId: string;
        readonly missionId: string;
        readonly title: string;
        readonly url: string;
        readonly domain: string;
        readonly state: 'live' | 'kept' | 'trash' | 'open';
      }[] = [];
      // E5-T01: index-first path (§2.11 correctness > freshness). 'unavailable' or an
      // absent port falls through to the §6.6 sweep; 'lagging' merges a bounded sweep
      // tail under the lagging flag; 'fresh' serves ranked-only. Resolved rows that the
      // tabs store can no longer produce are DROPPED, never fabricated.
      let mergedFreshness: 'fresh' | 'lagging' | 'fallback' = 'fallback';
      const seen = new Set<string>();
      if (deps.search !== undefined) {
        const ranked = await deps.search.query({
          q,
          scope: (scopeWanted === 'all' ? 'all' : scopeWanted) as
            'open' | 'kept' | 'closed' | 'all',
          limit,
        });
        if (!ranked.ok) return err(ranked.error);
        if (ranked.value.kind === 'ok') {
          const ids = ranked.value.answer.hits.map((h) => h.tabId);
          const rowsR = await deps.engine.txn(['tabs'], 'readonly', async (tx) => {
            const table = tx.table<StoredRecord>('tabs');
            const rows: (StoredRecord | undefined)[] = [];
            for (const id of ids) rows.push(await table.get(id));
            return rows;
          });
          if (!rowsR.ok) return err(rowsR.error);
          const rankedHits: typeof hits = [];
          for (const row of rowsR.value) {
            if (row === undefined) continue;
            const view = tabViewOf(row);
            rankedHits.push({
              tabId: view.tabId,
              missionId: view.missionId,
              title: view.title,
              url: view.url,
              domain: view.domain,
              state: view.state === 'live' ? 'open' : 'kept',
            });
          }
          // Ranked head ∪ bounded sweep tail, ALWAYS (recall-parity law recorded in the
          // E5 ADR note: the sweep is substring-honest and the index is term-based —
          // merging keeps reflex search at least as recall-complete as the shipped sweep
          // while ranking the head; 'closed' scope rides the same tail). Freshness from
          // the index side: < LAG_THRESHOLD ⇒ 'fresh', else 'lagging' (§2.11).
          mergedFreshness = ranked.value.answer.freshness;
          hits.push(...rankedHits);
          for (const h of rankedHits) seen.add(h.tabId);
        }
      }
      // §6.6 fallback sweep: keyword scan over kept/live rows (index-covered by state).
      const sweepStates: (readonly [scope: string, state: string])[] = [];
      if (scopes.includes('open')) sweepStates.push(['open', 'live']);
      if (scopes.includes('kept')) sweepStates.push(['kept', 'kept']);
      for (const [scope, state] of sweepStates) {
        const rows = await tabsByState(state);
        if (!rows.ok) return err(rows.error);
        for (const row of rows.value) {
          const haystack =
            `${str(row['title'])}\n${str(row['url'])}\n${str(row['domain'])}`.toLowerCase();
          if (!q.split(/\s+/).every((term) => haystack.includes(term))) continue;
          const view = tabViewOf(row);
          if (seen.has(view.tabId)) continue; // lag-merge: ranked head already carries it
          hits.push({
            tabId: view.tabId,
            missionId: view.missionId,
            title: view.title,
            url: view.url,
            domain: view.domain,
            state: scope === 'open' ? 'open' : view.state,
          });
          if (hits.length >= limit) break;
        }
      }
      if (scopes.includes('closed') && hits.length < limit) {
        const rcR = await deps.engine.txn(['recently_closed'], 'readonly', async (tx) =>
          tx.table<StoredRecord>('recently_closed').toArray(),
        );
        if (!rcR.ok) return err(rcR.error);
        for (const row of [...rcR.value].sort((a, b) => num(b['closedAt']) - num(a['closedAt']))) {
          const tabId = str(row['tabId']);
          const tabR = await deps.engine.txn(['tabs'], 'readonly', async (tx) =>
            tx.table<StoredRecord>('tabs').get(tabId),
          );
          if (!tabR.ok) return err(tabR.error);
          if (tabR.value === undefined) continue; // content-gone rows are not hits
          const haystack = `${str(tabR.value['title'])}\n${str(tabR.value['url'])}`.toLowerCase();
          if (!q.split(/\s+/).every((term) => haystack.includes(term))) continue;
          if (seen.has(tabId)) continue; // lag-merge dedupe
          hits.push({
            tabId,
            missionId: str(tabR.value['missionId']),
            title: str(tabR.value['title']),
            url: str(tabR.value['url']),
            domain: str(tabR.value['domain']),
            state: 'kept',
          });
          if (hits.length >= limit) break;
        }
      }
      // Correctness law, honestly flagged: 'fallback' = pure §6.6 sweep (no index or
      // index unavailable); 'lagging' = ranked head ∪ bounded sweep tail (§2.11 merge).
      return ok({
        results: hits.slice(0, limit),
        freshness: mergedFreshness,
        searchedScopes: scopes,
      });
    },

    getHealth: async () => {
      // E6-T03..T05: with the diagnostics seam wired the dump IS the registry
      // (user-ruled shapes: probes catalog-complete, lastBundle for the console
      // download gesture, recentRing timeline). Legacy map stands when unwired.
      if (deps.diagnostics !== undefined) {
        const probes = await deps.diagnostics.runProbes();
        if (!probes.ok) return err(probes.error);
        const bundle = await deps.diagnostics.lastBundle();
        if (!bundle.ok) return err(bundle.error);
        const ring = await deps.diagnostics.ringDump(HEALTH_TIMELINE_ROWS);
        if (!ring.ok) return err(ring.error);
        return ok({
          registryV: 1,
          probes: probes.value,
          lastBundle:
            bundle.value === null
              ? null
              : {
                  bundleId: bundle.value.bundleId,
                  createdAt: bundle.value.createdAt,
                  includeAddresses: bundle.value.includeAddresses,
                  size: bundle.value.size,
                  json: bundle.value.json,
                },
          recentRing: ring.value,
          asOf: deps.now(),
        } as unknown as Readonly<Record<string, unknown>>);
      }
      const status = await deps.projections.status();
      if (!status.ok) return err(status.error);
      const scan = await deps.journal.scanTail();
      const quota = await deps.engine.quota();
      return ok({
        projections: status.value.views.map((v) => ({
          view: v.view,
          dirty: v.dirty,
          projectorV: v.projectorV,
          watermarks: v.watermarks.map((w) => ({ deviceId: w.deviceId, seq: w.seq })),
        })),
        journalTailScan: scan.ok
          ? { status: scan.value.status, coverage: scan.value.coverage }
          : { status: 'error', code: scan.error.code },
        storage: quota.ok
          ? {
              apiAvailable: quota.value.apiAvailable,
              persisted: quota.value.persisted,
              ...(quota.value.pressureRatio !== undefined
                ? { pressureRatio: quota.value.pressureRatio }
                : {}),
            }
          : { apiAvailable: false },
        asOf: deps.now(),
      });
    },

    peekOpenTabs: async (input) => {
      const listed = await deps.tabs.query(
        input.windowId !== undefined ? { windowId: input.windowId } : {},
      );
      if (!listed.ok) return err(listed.error);
      return ok(listed.value.map((t) => openTabViewOf(t)));
    },

    getActivity: async (input) => {
      const limit = input?.limit ?? PAGE_SIZE_DEFAULT;
      // Recent Activity = the union timeline surfaces read: trash + recently-closed,
      // latest first (kept-history enrichment lands with the tabs projector history
      // tier — adr-noted).
      const trash = await (async () => {
        const tabs = await tabsByState('trash');
        if (!tabs.ok) return err(tabs.error);
        const missions = await missionsByState('trash');
        if (!missions.ok) return err(missions.error);
        return ok([
          ...tabs.value.map((r) => ({
            kind: 'tab' as const,
            id: str(r['ledgeTabId']),
            deletedAt: num(r['deletedAt']),
            displayName: str(r['title']) || str(r['domain']),
          })),
          ...missions.value.map((r) => ({
            kind: 'mission' as const,
            id: str(r['missionId']),
            deletedAt: num(r['deletedAt']),
            displayName: str(r['name']),
          })),
        ]);
      })();
      if (!trash.ok) return err(trash.error);
      const rcR = await deps.engine.txn(['recently_closed'], 'readonly', async (tx) =>
        tx.table<StoredRecord>('recently_closed').toArray(),
      );
      if (!rcR.ok) return err(rcR.error);
      const closed = rcR.value.map((r) => ({
        kind: 'tab' as const,
        id: str(r['tabId']),
        deletedAt: num(r['closedAt']),
        displayName: str(r['tabId']),
      }));
      const merged = [...trash.value, ...closed].sort((a, b) => b.deletedAt - a.deletedAt);
      return ok(merged.slice(0, limit));
    },
  };
};
