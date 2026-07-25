// E2-T08 · snapshot system types — EES-R5 chunking (500 tabRecords/part, ordered
// partIndex, shared snapshotId), EES-R4 group-style fidelity (mandatory
// groupStyles payload), §5 'sessions' store row, §4 SnapshotTaken event row.
//
// Law recap the module encodes:
//   - ONE SnapshotTaken event per snapshot (immutable truth); parts are the
//     MATERIALIZED 'sessions' store rows derived by canonical 500-chunking.
//   - partCount = ceil(refs/500); refs dedupe is order-stable first-win; empty
//     snapshots are lawful (partCount 0, zero rows — the event is the marker).
//   - groupStyles is a mandatory field (possibly []); every style record is
//     {groupId,name,color,collapsed,tabOrder[]}; a style is materialized into
//     exactly the parts its tabOrder intersects (part rows stay restore-complete
//     on their own — restore never joins across parts for style truth).
//   - Builder never mutates silently: orphan style refs (tabOrder ids outside
//     the snapshot) are pruned AND disclosed in diagnostics; duplicate refs are
//     dropped AND disclosed.
//   - Store 'trigger' comes only from the event (no fabrication): the registry
//     carries it as an additive optional field (v1 construction; every builder
//     emits it, tolerant readers accept its absence on hand-written fixtures).
import type { Id } from '@/shared-kernel/identity/index.js';

/** R5 chunk size (contract constant; change = schema event, not an edit). */
export const SNAPSHOT_CHUNK_SIZE = 500;

/** §5 sessions-row trigger vocabulary. */
export type SnapshotTrigger = 'auto' | 'park' | 'crash' | 'manual';

export const SNAPSHOT_TRIGGERS: readonly SnapshotTrigger[] = ['auto', 'park', 'crash', 'manual'];

/** EES-R4 style record (chrome tabGroups truth at capture time). */
export interface GroupStyle {
  readonly groupId: number;
  /** '' = unnamed group (chrome's own vocabulary). */
  readonly name: string;
  /** chrome color enum value; '' = unknown/none. */
  readonly color: string;
  readonly collapsed: boolean;
  /** Ledge tab ids in group order (restore fidelity). ⊆ snapshot refs after prune. */
  readonly tabOrder: readonly string[];
}

/** Builder input (already-structured truth; adapters normalize at their seam). */
export interface SnapshotInput {
  readonly snapshotId: Id;
  readonly missionId: Id;
  /** The mission's tab truth, in mission order. Duplicates are dropped (disclosed). */
  readonly tabRecordIds: readonly Id[];
  readonly groupStyles: readonly GroupStyle[];
  readonly takenAt: number;
  readonly trigger: SnapshotTrigger;
}

/** §4 SnapshotTaken wire payload (registry-conformant; trigger always emitted). */
export interface SnapshotTakenPayload {
  readonly snapshotId: string;
  readonly missionId: string;
  readonly partCount: number;
  readonly tabRecordRefs: readonly string[];
  readonly groupStyles: readonly GroupStyle[];
  readonly takenAt: number;
  readonly trigger: SnapshotTrigger;
}

export interface SnapshotDiagnostics {
  readonly partCount: number;
  /** Refs dropped by the order-stable dedupe. */
  readonly dedupedRefs: number;
  /** Style tabOrder ids pruned for pointing outside the snapshot (disclosed). */
  readonly prunedStyleRefs: number;
  /** Styles emptied entirely by pruning (kept: an empty group is still a style fact). */
  readonly emptiedStyles: number;
}

export interface SnapshotBuild {
  readonly payload: SnapshotTakenPayload;
  readonly diagnostics: SnapshotDiagnostics;
}

/** §5 'sessions' store row (one per part; pk [snapshotId+partIndex]). Type alias
 *  (not interface) so the row stays assignable to StoredRecord. */
export type SessionPartRow = {
  readonly snapshotId: string;
  readonly partIndex: number;
  readonly missionId: string;
  readonly tabRecordIds: readonly string[];
  readonly groupStyles: readonly GroupStyle[];
  readonly takenAt: number;
  readonly trigger?: SnapshotTrigger | undefined;
};

/** Part-completeness probe finding (one per violation, precise). */
export type SnapshotProbeIssue =
  | {
      readonly kind: 'missing-part';
      readonly snapshotId: string;
      readonly partIndex: number;
    }
  | {
      readonly kind: 'extra-part';
      readonly snapshotId: string;
      readonly partIndex: number;
    }
  | { readonly kind: 'untracked-row'; readonly snapshotId: string; readonly partIndex: number }
  | {
      readonly kind: 'duplicate-snapshot-event';
      readonly snapshotId: string;
      readonly count: number;
    }
  | {
      readonly kind: 'chunk-pattern';
      readonly snapshotId: string;
      readonly partIndex: number;
      readonly expectedSize: number;
      readonly actualSize: number;
    }
  | {
      readonly kind: 'id-mismatch';
      readonly snapshotId: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'style-mismatch';
      readonly snapshotId: string;
      readonly partIndex: number;
      readonly detail: string;
    }
  | {
      readonly kind: 'meta-mismatch';
      readonly snapshotId: string;
      readonly partIndex: number;
      readonly field: 'missionId' | 'takenAt' | 'trigger';
      readonly detail: string;
    };

export interface SnapshotIntegrityReport {
  readonly schemaV: 1;
  readonly deviceId: string;
  readonly rowsRead: number;
  readonly snapshotsChecked: number;
  /** true ⟺ zero issues — parts exactly [0..partCount-1], canonical chunks,
   *  ids order-exact, styles per part lawful, no untracked rows. */
  readonly complete: boolean;
  readonly issues: readonly SnapshotProbeIssue[];
}
