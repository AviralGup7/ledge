// E5-T03 · Canonical export model (ADR-045: "canonical in-memory export model =
// projection snapshot"). The model is built from the missions/tabs READ-MODEL rows —
// never from the journal, never from the (deletable) search index — and carries full
// provenance per EES §2.14 (formatV, app build id = contract hash, canonRulesV used).
// Truth discipline: tab rows referenced by a mission but absent from the tabs store
// are DROPPED AND COUNTED (no-silent-drop law); tabs without a resolvable non-trash
// mission export as loose tabs; trashed truth never crosses the front door.
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

export const EXPORT_FORMAT = 'ledge-export';
export const EXPORT_FORMAT_V = 1;
export const EXPORT_APP_NAME = 'Ledge';

/** One exported tab (content level; provenance rides additive fields). */
export interface ExportTabModel {
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly state: TabStoreRow['state'];
  readonly urlCanonHash?: string | undefined;
  readonly firstSeenAt?: number | undefined;
  readonly lastActiveAt?: number | undefined;
}

/** One exported mission with its tabs in mission order. */
export interface ExportMissionModel {
  readonly missionId: string;
  readonly name: string;
  readonly state: MissionViewRow['state'];
  readonly concluded: boolean;
  /** E8-T10 (W12 + the export covenant: "Mission export includes summary and
   *  outcome note as readable text"): verbatim row truth, absent-unless-noted. */
  readonly outcomeNote?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly lastActiveAt?: number | undefined;
  readonly tabs: readonly ExportTabModel[];
}

/** Structural drop disclosure — the no-silent-partial law's arithmetic surface. */
export interface ExportDiagnostics {
  /** Mission.tabIds refs with no tabs-store row (dropped, counted — never fabricated). */
  readonly droppedTabRefs: number;
}

/** The canonical model — ADR-045's promise object; renderers consume ONLY this. */
export interface CanonicalExportModel {
  readonly format: typeof EXPORT_FORMAT;
  readonly formatV: typeof EXPORT_FORMAT_V;
  readonly app: { readonly name: typeof EXPORT_APP_NAME; readonly build: string };
  readonly canonRulesV: number;
  readonly generatedAt: number;
  readonly scope: 'all' | { readonly mission: string };
  readonly missions: readonly ExportMissionModel[];
  readonly looseTabs: readonly ExportTabModel[];
  readonly diagnostics: ExportDiagnostics;
}

/** Read-model row feed — the application/ports seam the depcruise law allows.
 *  Engine errors pass through verbatim (P-25: adapters transport, never mint). */
export interface ExportModelSource {
  readonly missions: () => Promise<Result<readonly MissionViewRow[], LedgeError>>;
  readonly tabs: () => Promise<Result<readonly TabStoreRow[], LedgeError>>;
}

export interface BuildModelInput {
  readonly scope: 'all' | { readonly mission: string };
  /** Resolved read-model rows (the projection snapshot's raw material). */
  readonly rows: {
    readonly missions: readonly MissionViewRow[];
    readonly tabs: readonly TabStoreRow[];
  };
  /** Contract hash of the running build (build-id provenance, §2.14). */
  readonly build: string;
  /** canonRulesV in force at export time (provenance, never row-derived). */
  readonly canonRulesV: number;
  readonly now: () => number;
}

const tabModelOf = (row: TabStoreRow): ExportTabModel => ({
  url: row.url,
  title: row.title,
  domain: row.domain,
  state: row.state,
  ...(row.urlCanonHash !== undefined && row.urlCanonHash !== null
    ? { urlCanonHash: row.urlCanonHash }
    : {}),
  ...(row.firstSeenAt !== undefined ? { firstSeenAt: row.firstSeenAt } : {}),
  ...(row.lastActiveAt !== undefined ? { lastActiveAt: row.lastActiveAt } : {}),
});

/**
 * Build the canonical model for a scope. Deterministic ordering law (same truth ⇒
 * same bytes ⇒ same checksums): missions sort by createdAt (then id), tabs ride
 * mission declaration order, loose tabs sort by firstSeenAt (then id).
 */
export const buildModel = (input: BuildModelInput): CanonicalExportModel => {
  const { missions, tabs } = input.rows;
  const tabById = new Map<string, TabStoreRow>();
  for (const row of tabs) tabById.set(row.ledgeTabId, row);

  const exportable = missions
    .filter(
      (m) => m.state !== 'trash' && (input.scope === 'all' || m.missionId === input.scope.mission),
    )
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        (a.missionId < b.missionId ? -1 : a.missionId > b.missionId ? 1 : 0),
    );

  let droppedTabRefs = 0;
  const covered = new Set<string>();
  const missionModels: ExportMissionModel[] = exportable.map((m) => {
    const tabsOut: ExportTabModel[] = [];
    for (const tabId of m.tabIds) {
      covered.add(tabId);
      const row = tabById.get(tabId);
      if (row === undefined || row.state === 'trash') {
        droppedTabRefs += 1;
        continue;
      }
      tabsOut.push(tabModelOf(row));
    }
    return {
      missionId: m.missionId,
      name: m.name,
      state: m.state,
      concluded: m.concluded,
      ...(m.outcomeNote !== undefined && m.outcomeNote.length > 0
        ? { outcomeNote: m.outcomeNote }
        : {}),
      ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
      ...(m.lastActiveAt !== undefined ? { lastActiveAt: m.lastActiveAt } : {}),
      tabs: tabsOut,
    };
  });

  const loose = tabs
    .filter((t) => t.state !== 'trash' && !covered.has(t.ledgeTabId))
    .sort(
      (a, b) =>
        a.firstSeenAt - b.firstSeenAt ||
        (a.ledgeTabId < b.ledgeTabId ? -1 : a.ledgeTabId > b.ledgeTabId ? 1 : 0),
    )
    .map(tabModelOf);

  return {
    format: EXPORT_FORMAT,
    formatV: EXPORT_FORMAT_V,
    app: { name: EXPORT_APP_NAME, build: input.build },
    canonRulesV: input.canonRulesV,
    generatedAt: input.now(),
    scope: input.scope === 'all' ? 'all' : { mission: input.scope.mission },
    missions: missionModels,
    looseTabs: loose,
    diagnostics: { droppedTabRefs },
  };
};
