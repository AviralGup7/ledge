// E3-APP · View-row declarations — the §5 storage-contract shapes the PROJECTION family
// writes and the APPLICATION read side (queries, DTO mapping) consumes. Declarations
// live at the port seam per ADR-043 ("application holds ports/interfaces"): the
// projectors (infrastructure/projections) import these rows exactly like they import
// the storage engine port — direction law stays infrastructure → application/ports.
//
// Rows are forward-tolerant by §2.9: additive fields lawful, unknown preserved.
/** §5 'missions' row (view shape). Type alias for StoredRecord's implicit signature.
 *  E3-APP growth (§2.9 additive): 'parked' stamps at ParkIntentAccepted ack (the
 *  intent-driven derivation — projector-records the durable intent; abort-revert has
 *  no §4 carrier in v1, recorded in docs/adr-notes/e3-app-layer.md), 'trash' stamps
 *  at EntityTrashed. windowBinding/parkIntentId/deletedAt are additive row fields. */
export type MissionViewRow = {
  readonly missionId: string;
  readonly name: string;
  readonly namedBy: string;
  readonly state: 'live' | 'parked' | 'archived' | 'trash';
  readonly concluded: boolean;
  readonly tabIds: readonly string[];
  readonly createdAt: number;
  readonly lastActiveAt: number;
  /** Chrome window id while the mission is open (StartMission bind, resume re-bind). */
  readonly windowBinding?: number | null | undefined;
  /** The accepted park intent covering this mission (audit/coordinate for R2 flows). */
  readonly parkIntentId?: string | undefined;
  /** Trash stamp (state==='trash'); retention reads it. */
  readonly deletedAt?: number | undefined;
};

/** §5 'recently_closed' row. */
export type RecentlyClosedRow = {
  readonly entryId: string;
  readonly tabId: string;
  readonly closedAt: number;
  readonly source: 'external' | 'reconciled';
  readonly missionId?: string | undefined;
  readonly snapshotRef?: string | undefined;
};

/** §5 'tabs' row (ledger-truth record of one browser tab's Ledge lifecycle). */
export type TabStoreRow = {
  readonly ledgeTabId: string;
  readonly missionId: string;
  readonly url: string;
  readonly urlCanonHash?: string | undefined;
  readonly canonRulesV?: number | undefined;
  readonly title: string;
  readonly domain: string;
  readonly state: 'live' | 'kept' | 'trash';
  readonly firstSeenAt: number;
  readonly lastActiveAt: number;
  readonly browserTabId?: number | undefined;
  /** Chrome window the live tab sits in (C5 bound-or-forms derivation at park time). */
  readonly windowId?: number | undefined;
  /** Chrome group the live tab sits in (C4 group-park scoping; null = ungrouped). */
  readonly groupId?: number | null | undefined;
  readonly deletedAt?: number | undefined;
  readonly note?: string | undefined;
};

/** §5 'memory_artifacts' row (read side; writers are domain/memory families). */
export type MemoryArtifactRow = {
  readonly artifactId: string;
  readonly subjectId: string;
  readonly kind: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly provider: string;
  readonly modelClass: string;
  readonly schemaV?: number | undefined;
};
