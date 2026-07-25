// E2-T04 · ADR-034 — migration runner contracts.
// The runner owns the ONLY schema-evolution path (EES §2.9: "migrations:
// checkpoint → migrate → assert → rollback-on-fail"). The engine port never
// version-negotiates; its open() foreign-version assert + schemaVersion()
// are the runner's integration surface with boot/recovery.
//
// Pipeline laws (ADR-034, verbatim mapping):
//   1. pre-migration auto-checkpoint — caller injects the checkpoint capability
//      (journal.checkpoint over the CURRENT-version engine); refusal ⇒ abort
//      before any byte changes, error surfaces verbatim.
//   2. transactional migration — every step's transform runs inside the IDB
//      versionchange transaction; platform atomicity IS the rollback machine.
//   3. post-migration invariant assertion — counts / referential integrity run
//      inside the SAME transaction; a violation throws ⇒ full restore.
//   4. on failure, surface E_MIGRATION (mapped msg.error.migration +
//      msg.recover.export — the calm error with export offer, per ADR-034).
// Destructive transforms are forbidden: VersionMap validation enforces the
// additive-only declaration law. Chunked-resumable machinery stays unbuilt
// per ADR-034's own reconsider note (no mega-archive migration exists).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
// additive-only declaration law. Chunked-resumable machinery stays unbuilt
// per ADR-034's own reconsider note (no mega-archive migration exists).

/** Store record as seen at the raw migration layer (structured-clone domain). */
export type MigrationRecord = Readonly<Record<string, unknown>>;

/**
 * Per-step data access over the IDB versionchange transaction. Store names are
 * raw strings here, not the StoreName catalog union: a step may legally
 * introduce a store the current build's catalog does not know yet.
 */
export interface MigrationStoreAccess {
  toArray(store: string): Promise<readonly MigrationRecord[]>;
  count(store: string): Promise<number>;
  put(store: string, record: MigrationRecord): Promise<void>;
  /** One IDB request batch for bulk writes — steps use this for table-wide
   *  additions so large-store steps stay inside ADR-034's <5s budget. */
  putMany(store: string, records: readonly MigrationRecord[]): Promise<void>;
  delete(store: string, key: string | number): Promise<void>;
}

/**
 * A step's pure data transform. Purity law (ADR-034 "migrations are pure,
 * tested with golden fixtures"): same input bytes ⇒ same output bytes, no
 * wall-clock, no entropy, no fields dropped — unknown fields pass through
 * verbatim (the forward-tolerance law does not pause for migration).
 */
export type MigrationTransform = (db: MigrationStoreAccess) => Promise<void>;

/**
 * Post-condition law for a step, asserted in-transaction after the transform.
 * Throws MigrationInvariantViolation (or any Error) on breach ⇒ transaction
 * aborts ⇒ pre-migration bytes restored by the platform.
 */
export type MigrationInvariant = (db: MigrationStoreAccess) => Promise<void>;

/**
 * One schema step N-1 → N (ADR-034 additive + shadow + switch pattern).
 * `stores` declares ONLY the step's schema delta (Dexie merges with prior
 * versions). Store deletion (null spec) is not expressible: destructive
 * schema change is a type-level impossibility, not a convention.
 */
export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly stores: Readonly<Record<string, string>>;
  readonly transform?: MigrationTransform | undefined;
  readonly invariants?: readonly MigrationInvariant[] | undefined;
}

/**
 * The ordered ledger of schema versions. base = schema v1 layout; steps are
 * validated for consecutiveness at construction (a gap is a programmer bug —
 * TypeError, not a runtime Result).
 */
export interface VersionMap {
  readonly baseVersion: number;
  readonly baseStores: Readonly<Record<string, string>>;
  readonly steps: readonly MigrationStep[];
}

export type MigrationKind =
  /** No database existed (meta unstamped, every store empty). */
  | 'fresh-install'
  /** An older database was advanced through ≥1 step. */
  | 'migrated'
  /** Database already at target — nothing written, checkpoint not consulted. */
  | 'no-op';

export interface MigrationReport {
  readonly kind: MigrationKind;
  /** Version before migrate(); FRESH_INSTALL (0) when there was no database. */
  readonly fromVersion: number;
  readonly toVersion: number;
  /** `to` of every step actually applied, in application order. */
  readonly stepsApplied: readonly number[];
  /** True when the pre-migration checkpoint capability ran and succeeded. */
  readonly checkpointed: boolean;
}

/**
 * ADR-034 law 1 seam: the pre-migration journal checkpoint. Required whenever
 * an existing database is about to be advanced — a missing capability is a
 * wiring defect, surfaced as E_MIGRATION (never a silent skip).
 */
export type CheckpointCapability = () => Promise<Result<unknown, LedgeError>>;

export interface MigrationRunnerDeps {
  readonly databaseName?: string | undefined;
  /** Test seam: fake-indexeddb injects {indexedDB, idbKeyRange}. */
  readonly indexedDB?: IDBFactory | undefined;
  readonly idbKeyRange?: typeof IDBKeyRange | undefined;
  readonly versionMap: VersionMap;
  readonly checkpoint?: CheckpointCapability | undefined;
}

export interface MigrationRunner {
  migrate(): Promise<Result<MigrationReport, LedgeError>>;
  /**
   * Byte image of every declared store at a version ≤ target (default: target)
   * — the audit primitive for golden-fixture equality and the future export
   * offer. Reads through the declared chain; never mutates.
   */
  snapshot(
    throughVersion?: number,
  ): Promise<Result<Readonly<Record<string, readonly MigrationRecord[]>>, LedgeError>>;
}
