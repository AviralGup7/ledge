// E3-APP · domain/lifecycle (EES §2.5 + M2-WP1) — the lifecycle state vocabulary.
// States are data declarations only (P-08): the transition legality lives in
// transitions.ts. §5 freezes the STORE shapes; state VALUES are the domain's reading
// of those rows (additive per §2.9 — projector v1 knew live|archived; the domain adds
// parked|trash as view-registry growth lands with use cases, per projections/index
// law "the registry grows with use-cases").

/** Mission container state (§5 missions.state; concluded rides its own flag). */
export type MissionState = 'live' | 'parked' | 'archived' | 'trash';

/** Individual tab record state (§5 tabs.state — frozen set). */
export type TabState = 'live' | 'kept' | 'trash';

/** Trash-able entity kinds (C15/C16 contract enums). */
export type TrashableKind = 'tab' | 'mission';

/** Subject snapshot the application passes in (projection state passed BY CALLER). */
export interface SubjectSnapshot {
  readonly kind: TrashableKind | 'topic' | 'library';
  readonly id: string;
  readonly state: string;
  readonly parentMissionId?: string | undefined;
  readonly tabIds?: readonly string[] | undefined;
  readonly deletedAt?: number | undefined;
  readonly tabCount?: number | undefined;
}
