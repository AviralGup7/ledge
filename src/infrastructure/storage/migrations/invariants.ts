// E2-T04 · ADR-034 law 3 — post-migration invariant assertion helpers.
// Pure builders returning MigrationInvariant closures; every breach throws a
// MigrationInvariantViolation, which the runner maps to E_MIGRATION with the
// violation's primitives in details (store / want / got). Assertions run
// INSIDE the versionchange transaction, so a breach restores pre-migration
// bytes via platform rollback — nothing is ever half-migrated.
import type { MigrationInvariant, MigrationRecord } from './types.js';

/** Thrown by invariant closures; the runner recognizes failures by this name. */
export const INVARIANT_VIOLATION_NAME = 'MigrationInvariantViolation';

export const invariantViolation = (
  kind: string,
  facts: Readonly<Record<string, string | number>>,
): Error =>
  Object.assign(new Error(`migration invariant breach: ${kind}`), {
    name: INVARIANT_VIOLATION_NAME,
    kind,
    facts,
  });

const factsOf = (e: unknown): Readonly<Record<string, string | number>> | undefined => {
  if (typeof e === 'object' && e !== null && 'facts' in e) {
    const f = (e as { facts: unknown }).facts;
    if (typeof f === 'object' && f !== null) return f as Readonly<Record<string, string | number>>;
  }
  return undefined;
};

/** Re-exported so the runner can extract violation primitives without casts. */
export const violationFacts = factsOf;

/** ADR-034 "counts": every listed store must hold exactly the expected row count. */
export const requireStoreCounts = (
  expected: Readonly<Record<string, number>>,
): MigrationInvariant => {
  return async (db) => {
    for (const [store, want] of Object.entries(expected)) {
      const got = await db.count(store);
      if (got !== want) throw invariantViolation('store-count', { store, want, got });
    }
  };
};

/**
 * ADR-034 "referential integrity": every non-null child foreign key must
 * resolve to an existing parent primary key. Null/absent FKs are lawful
 * (optional membership, e.g. an unassigned tab's missionId).
 */
export const requireReferential = (
  childStore: string,
  childKey: string,
  parentStore: string,
  parentKey: string,
): MigrationInvariant => {
  return async (db) => {
    const parents: ReadonlySet<unknown> = new Set(
      (await db.toArray(parentStore)).map((row: MigrationRecord) => row[parentKey]),
    );
    for (const row of await db.toArray(childStore)) {
      const fk = row[childKey];
      if (fk === undefined || fk === null) continue;
      if (!parents.has(fk)) {
        throw invariantViolation('referential', {
          childStore,
          parentStore,
        });
      }
    }
  };
};
