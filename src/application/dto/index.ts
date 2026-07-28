// E3-APP · Mission deliverable "Application DTOs + Result mapping" — the shapes that
// cross application → surface. Law: DTOs are derived, display-free Data; every field a
// surface sees is listed here (never a store row passthrough — internal fields
// (urlCanonHash, canonRulesV, derivedFromSeqRange, schemaV, contentIndexFlag, scroll)
// stop at this boundary). Unknown fields inside rows ride forward-tolerance: missing /
// extra row fields degrade, never throw (storage §2.9 law mirrored read-side).
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { MissionViewRow, RecentlyClosedRow } from '@/application/ports/view-rows.js';
import type { RecentlyClosedTab } from '@/application/ports/sessions.port.js';
import type { TabInfo } from '@/application/ports/tabs.port.js';

// Row declarations come from the application port seam (view-rows.ts) — the DTO
// boundary never reaches into infrastructure.

/** Lifecycle mission state as surfaces understand it (additive: 'trash' is E3-incoming). */
export type MissionState = MissionViewRow['state'] | 'trash';

export interface MissionView {
  readonly missionId: string;
  readonly name: string;
  readonly namedBy: string;
  readonly state: MissionState;
  readonly concluded: boolean;
  /** E8-T10 (W12): the outcome note, verbatim from the row (absent unless a
   *  noted conclude landed — surfaces render it as the Archive badge). */
  readonly outcomeNote?: string | undefined;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  /** Denormalized at map time (count of the current membership). */
  readonly tabCount: number;
}

/** Tab state as surfaces understand it (§5 tabs row). */
export type TabState = 'live' | 'kept' | 'trash';

export interface TabView {
  readonly tabId: string;
  readonly missionId: string;
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly state: TabState;
  readonly firstSeenAt: number;
  readonly lastActiveAt: number;
  readonly note?: string | undefined;
}

export interface ArtifactView {
  readonly artifactId: string;
  readonly subjectId: string;
  readonly kind: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly provider: string;
  readonly modelClass: string;
}

export interface MissionDetailView {
  readonly mission: MissionView;
  readonly tabs: readonly TabView[];
  readonly artifacts: readonly ArtifactView[];
}

export interface RecentlyClosedEntryView {
  readonly entryId: string;
  readonly tabId: string;
  readonly closedAt: number;
  readonly source: RecentlyClosedRow['source'];
  readonly missionId?: string | undefined;
  readonly snapshotRef?: string | undefined;
}

export type TrashKind = 'tab' | 'mission' | 'batch';

export interface TrashEntryView {
  readonly kind: TrashKind;
  readonly id: string;
  readonly deletedAt: number;
  readonly displayName: string;
  /** Parent resolution input for C16 (dead-parent rule, §10-R13). */
  readonly parentMissionId?: string | undefined;
}

export interface LibraryPage {
  readonly missions: readonly MissionView[];
  readonly nextCursor?: string | undefined;
}

export interface HeartbeatView {
  readonly keptCount: number;
  readonly liveRecoverable: number;
  readonly asOf: number;
}

export interface BootstrapView {
  readonly missions: readonly MissionView[];
  readonly recentlyClosed: readonly RecentlyClosedEntryView[];
  readonly trashCount: number;
  readonly watermark: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly heartbeat: HeartbeatView;
}

export interface SearchHitView {
  readonly tabId: string;
  readonly missionId: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly state: TabState | 'open';
}

export interface SearchResultsView {
  readonly results: readonly SearchHitView[];
  readonly freshness: 'fresh' | 'lagging' | 'fallback';
  readonly searchedScopes: readonly string[];
}

/**
 * E6-T01 · W7 report DTO (GetBootReport response). Display-free: copyKey is the
 * report's own §14.4-computed catalog key, disclosure entries are STABLE TOKENS
 * with counts (the catalog renders them — payloads never carry copy, §3.2).
 * Scope is TRUTH-NOW (current restorable rows), asOf is last-known tab activity.
 */
export interface BootReportDisclosure {
  readonly token: string;
  readonly count: number;
}

export interface BootReportView {
  readonly bootReportId: string;
  readonly severity: 'loss-risk' | 'clean-abnormal';
  /** Marker taxonomy (EES-R16): updated | crashed | warm-recycle | first-run | undetectable. */
  readonly cause: string;
  readonly copyKey: string | null;
  readonly outcome: string;
  readonly asOf: number;
  readonly scope: {
    readonly tabsRecoverable: number;
    readonly missionsAffected: number;
  };
  readonly crossCheck: string;
  /**
   * E6-T02 cross-check candidates — the boot-time Recently Closed backlog rows
   * whose URL matched NO live-scope journal row (F1 unmatched-only). Snapshotted
   * ONCE at incident creation and immutable thereafter (F3 snapshot law): the
   * card always shows what that boot observed, never a live re-query. Absent ⟺
   * no snapshot was taken (non-incident slot, sessions seam unwired/unavailable).
   */
  readonly crossCheckCandidates?: readonly RecentlyClosedTab[] | undefined;
  readonly disclosure: readonly BootReportDisclosure[];
  /** §14.4 card predicate: severity loss-risk AND unsettled. */
  readonly pending: boolean;
  readonly restoredAt: number | null;
}

export interface OpenTabView {
  readonly browserTabId: number;
  readonly windowId: number;
  readonly title: string;
  readonly url: string;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly groupId: number | null;
}

// ── Mapping (row → dto; total functions, forward-tolerant) ────────────────────────

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

const KNOWN_STATES: readonly string[] = ['live', 'parked', 'archived', 'trash'];

export const missionViewOf = (
  row: MissionViewRow | (StoredRecord & { tabIds?: unknown }),
): MissionView => {
  const r = row as Readonly<Record<string, unknown>>;
  const stateRaw = str(r['state'], 'live');
  const tabIds = r['tabIds'];
  return {
    missionId: str(r['missionId']),
    name: str(r['name']),
    namedBy: str(r['namedBy'], 'system'),
    state: (KNOWN_STATES.includes(stateRaw) ? stateRaw : 'live') as MissionState,
    concluded: r['concluded'] === true,
    ...(typeof r['outcomeNote'] === 'string' && (r['outcomeNote'] as string).length > 0
      ? { outcomeNote: r['outcomeNote'] as string }
      : {}),
    createdAt: num(r['createdAt']),
    lastActiveAt: num(r['lastActiveAt']),
    tabCount: Array.isArray(tabIds) ? tabIds.length : 0,
  };
};

const TAB_STATES: readonly string[] = ['live', 'kept', 'trash'];

export const tabViewOf = (row: StoredRecord): TabView => {
  const stateRaw = str(row['state'], 'kept');
  const note = row['note'];
  return {
    tabId: str(row['ledgeTabId']),
    missionId: str(row['missionId']),
    url: str(row['url']),
    title: str(row['title']),
    domain: str(row['domain']),
    state: (TAB_STATES.includes(stateRaw) ? stateRaw : 'kept') as TabState,
    firstSeenAt: num(row['firstSeenAt']),
    lastActiveAt: num(row['lastActiveAt']),
    ...(typeof note === 'string' && note.length > 0 ? { note } : {}),
  };
};

export const artifactViewOf = (row: StoredRecord): ArtifactView => ({
  artifactId: str(row['artifactId']),
  subjectId: str(row['subjectId']),
  kind: str(row['kind']),
  value: row['value'],
  confidence: num(row['confidence'], 0),
  provider: str(row['provider'], 'unknown'),
  modelClass: str(row['modelClass'], 'unknown'),
});

export const recentlyClosedViewOf = (row: RecentlyClosedRow): RecentlyClosedEntryView => ({
  entryId: row.entryId,
  tabId: row.tabId,
  closedAt: row.closedAt,
  source: row.source,
  ...(row.missionId !== undefined ? { missionId: row.missionId } : {}),
  ...(row.snapshotRef !== undefined ? { snapshotRef: row.snapshotRef } : {}),
});

export const openTabViewOf = (info: TabInfo): OpenTabView => ({
  browserTabId: info.browserTabId,
  windowId: info.windowId,
  title: info.title,
  url: info.url,
  pinned: info.pinned,
  active: info.active,
  groupId: info.groupId,
});
