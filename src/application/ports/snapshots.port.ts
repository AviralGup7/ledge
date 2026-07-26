// E3-APP · SnapshotsPort — application use cases (park plan, resume materialization)
// interact with the snapshots family ONLY through this seam (application →
// infrastructure is forbidden; the family implements and the roots wire). The shapes
// below re-declare the §5 'sessions' row contract as port wire types — additive-tolerant,
// unknown-preserved per §2.9, never adapter-flavored.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** EES-R4 style record (chrome tabGroups truth at capture time) — §4 §3 payload shape,
 *  re-declared at the port seam (the snapshots family's declaration is its adapter-local
 *  copy; values must stay wire-identical because they persist inside journal payloads). */
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

/** §5 'sessions' part row (compound key snapshotId+partIndex per the store contract). */
export interface SessionPartRow {
  readonly snapshotId: string;
  readonly partIndex: number;
  readonly missionId: string;
  readonly tabRecordIds: readonly string[];
  readonly groupStyles: readonly GroupStyle[];
  readonly takenAt: number;
  readonly trigger: 'auto' | 'park' | 'crash' | 'manual';
}

/** Build input for one snapshot payload (the park-plan material of invariant (i)). */
export interface SnapshotBuildInput {
  readonly missionId: string;
  readonly tabRecordIds: readonly string[];
  readonly groupStyles: readonly GroupStyle[];
  readonly takenAt: number;
  readonly trigger: SessionPartRow['trigger'];
}

/** The §4 SnapshotTaken payload the builder proves before any bytes land. */
export interface SnapshotBuild {
  readonly snapshotId: string;
  readonly payload: {
    readonly snapshotId: string;
    readonly missionId: string;
    readonly partCount: number;
    readonly tabRecordRefs: readonly string[];
    readonly groupStyles: readonly GroupStyle[];
    readonly takenAt: number;
    /** §4 additive-optional; builders always emit it (sessions rows materialize it). */
    readonly trigger: SessionPartRow['trigger'];
  };
  readonly parts: readonly SessionPartRow[];
}

export interface SnapshotsPort {
  /** Invariant-(i) material: build the payload + part rows for a parked scope. */
  build(input: SnapshotBuildInput): Promise<Result<SnapshotBuild, LedgeError>>;
  /** Read assembled part rows for a snapshot (resume materialization). */
  parts(snapshotId: string): Promise<Result<readonly SessionPartRow[], LedgeError>>;
}
