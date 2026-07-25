// E2-T04 · ADR-034 — the migration runner. Executes checkpoint → migrate →
// assert → rollback-on-fail over Dexie versioned migrations (the only place in
// the codebase where an IDB versionchange may be orchestrated).
//
// Rollback law mechanics: IDB versionchange transactions are atomic. Every
// step's transform AND its invariants run inside that transaction, so any
// throw — transform defect, invariant breach, crash mid-upgrade — restores
// the pre-migration bytes by platform guarantee. The runner never builds its
// own undo machinery.
//
// Invocation jurisdiction (documented contract for v2+ builds): when
// engine.open() reports E_MIGRATION (foreign version), boot/recovery composes
// this runner against the same databaseName with a checkpoint capability
// bound to journal.checkpoint() over the CURRENT-version engine, migrates,
// then retries open(). Close every other handle to the database first —
// IDB refuses a versionchange while sibling connections hold the old version.
import { Dexie, type Transaction } from 'dexie';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { DEFAULT_DB_NAME, META_SCHEMA_KEY } from '../dexie-engine.js';
import { mapStorageError } from '../error-map.js';
import { SCHEMA_V1, SCHEMA_VERSION_V1 } from '../schema/schema.v1.js';
import { INVARIANT_VIOLATION_NAME, violationFacts } from './invariants.js';
import type {
  CheckpointCapability,
  MigrationRecord,
  MigrationReport,
  MigrationRunner,
  MigrationRunnerDeps,
  MigrationStep,
  MigrationStoreAccess,
  VersionMap,
} from './types.js';

/** Version reported when no database (or no user bytes) exists yet. */
const FRESH_INSTALL = 0;

/**
 * The production ledger: schema v1 is the first and, until a real schema v2 is
 * designed by ADR, the ONLY version. The runner machinery is proven against a
 * synthetic v1→v2 golden fixture suite (ops/fixtures/migrations/v1-to-v2/) so
 * the day v2 ships it lands on an already-adversarially-tested pipeline.
 */
export const PRODUCTION_VERSION_MAP: VersionMap = {
  baseVersion: SCHEMA_VERSION_V1,
  baseStores: SCHEMA_V1,
  steps: [],
};

/** Dexie wraps an upgrade-throw; the underlying cause rides here. */
const DEXIE_UPGRADE_ERROR = 'UpgradeError';

const errorNameOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string'
    ? e.name
    : typeof e;

const innerNameOf = (e: unknown): string | undefined => {
  if (typeof e !== 'object' || e === null || !('inner' in e)) return undefined;
  const inner = (e as { inner: unknown }).inner;
  return typeof inner === 'object' &&
    inner !== null &&
    'name' in inner &&
    typeof inner.name === 'string'
    ? inner.name
    : undefined;
};

/** LedgeError details are primitives-only (§3.2); foreign facts objects are filtered. */
const sanitizeFacts = (
  facts: Readonly<Record<string, string | number>> | undefined,
): Readonly<Record<string, string | number>> | undefined => {
  if (facts === undefined) return undefined;
  const clean = Object.fromEntries(
    Object.entries(facts).filter(
      ([, v]) =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null,
    ),
  ) as Readonly<Record<string, string | number>>;
  return Object.keys(clean).length === 0 ? undefined : clean;
};

/** Structured search inside a Dexie UpgradeError wrapper for our invariant breach. */
const unwrapViolation = (
  e: unknown,
): { name: string; facts?: Readonly<Record<string, string | number>> | undefined } => {
  const name = errorNameOf(e);
  if (name !== DEXIE_UPGRADE_ERROR) {
    const clean = name === INVARIANT_VIOLATION_NAME ? sanitizeFacts(violationFacts(e)) : undefined;
    return clean === undefined ? { name } : { name, facts: clean };
  }
  const inner = (e as { inner?: unknown }).inner;
  if (inner !== undefined && errorNameOf(inner) === INVARIANT_VIOLATION_NAME) {
    const clean = sanitizeFacts(violationFacts(inner));
    return clean === undefined
      ? { name: INVARIANT_VIOLATION_NAME }
      : { name: INVARIANT_VIOLATION_NAME, facts: clean };
  }
  const innerName = innerNameOf(e);
  return innerName === undefined ? { name } : { name, facts: { inner: innerName } };
};

/** Map validation: schema steps must be consecutive, unit-increment, additive-only. */
const validateMap = (map: VersionMap): VersionMap => {
  if (!Number.isInteger(map.baseVersion) || map.baseVersion < 1) {
    throw new TypeError('version map: baseVersion must be a positive integer');
  }
  let expectedFrom = map.baseVersion;
  for (const step of map.steps) {
    if (step.from !== expectedFrom || step.to !== step.from + 1) {
      throw new TypeError(
        `version map: steps must be consecutive unit increments (expected from=${String(expectedFrom)}, got ${String(step.from)}→${String(step.to)})`,
      );
    }
    for (const [store, spec] of Object.entries(step.stores)) {
      if (typeof spec !== 'string' || spec.length === 0) {
        // Additive-only law: a null/absent spec would DELETE a store (Dexie semantics).
        throw new TypeError(
          `version map: ${String(step.to)} store "${store}" is not an additive declaration`,
        );
      }
    }
    expectedFrom = step.to;
  }
  return map;
};

const storeNamesThrough = (map: VersionMap, throughVersion: number): readonly string[] => {
  const names: string[] = Object.keys(map.baseStores);
  for (const step of map.steps) {
    if (step.to > throughVersion) break;
    for (const store of Object.keys(step.stores)) {
      if (!names.includes(store)) names.push(store);
    }
  }
  return names;
};

export function createMigrationRunner(deps: MigrationRunnerDeps): MigrationRunner {
  const map = validateMap(deps.versionMap);
  const last = map.steps.at(-1);
  const target = last === undefined ? map.baseVersion : last.to;
  const dbName = deps.databaseName ?? DEFAULT_DB_NAME;

  const newDexie = (): Dexie => {
    const dexieOpts: { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange } = {};
    if (deps.indexedDB !== undefined) dexieOpts.indexedDB = deps.indexedDB;
    if (deps.idbKeyRange !== undefined) dexieOpts.IDBKeyRange = deps.idbKeyRange;
    return new Dexie(dbName, deps.indexedDB === undefined ? undefined : dexieOpts);
  };

  const makeAccess = (tx: Transaction): MigrationStoreAccess => ({
    toArray: async (store) => tx.table(store).toArray() as Promise<readonly MigrationRecord[]>,
    count: (store) => tx.table(store).count() as Promise<number>,
    put: async (store, record) => {
      await tx.table(store).put(record);
    },
    putMany: async (store, records) => {
      await tx.table(store).bulkPut([...records]);
    },
    delete: async (store, key) => {
      await tx.table(store).delete(key);
    },
  });

  const runStep = async (tx: Transaction, step: MigrationStep): Promise<void> => {
    const db = makeAccess(tx);
    if (step.transform !== undefined) await step.transform(db);
    for (const invariant of step.invariants ?? []) await invariant(db);
    // §2.9 version integer: stamped with the step's own commit — a schema and
    // its stamp share one fate, so a half-stamp cannot exist.
    await makeAccess(tx).put('meta', { key: META_SCHEMA_KEY, value: step.to });
  };

  /**
   * Open declaring the chain base..throughVersion. When `withUpgrades`, step
   * callbacks are attached (the migrate path); otherwise this is a pure reader.
   */
  const openChain = async (throughVersion: number, withUpgrades: boolean): Promise<Dexie> => {
    const db = newDexie();
    db.version(map.baseVersion).stores({ ...map.baseStores });
    for (const step of map.steps) {
      if (step.to > throughVersion) break;
      const decl = db.version(step.to).stores({ ...step.stores });
      if (withUpgrades) decl.upgrade((tx) => runStep(tx, step));
    }
    await db.open();
    return db;
  };

  /** Tri-state probe at BASE layout: version integer | fresh | corrupt-refusal. */
  const probeCurrent = async (): Promise<Result<number, LedgeError>> => {
    let db: Dexie;
    try {
      db = await openChain(map.baseVersion, false);
    } catch (e) {
      return err(mapStorageError(e, 'open'));
    }
    try {
      const metaRow = (await db.table('meta').get(META_SCHEMA_KEY)) as
        { readonly value?: unknown } | undefined;
      if (metaRow !== undefined) {
        return typeof metaRow.value === 'number'
          ? ok(metaRow.value)
          : err(
              ledgeError('E_CORRUPT_STORE', { site: 'migrate-probe', raw: 'schemaV-not-number' }),
            );
      }
      // No stamp: lawful ONLY when the database carries zero user bytes
      // (fresh-install probe per this module's contract). A store with rows
      // and no version integer is corruption-class — rescue path jurisdiction.
      const names = Object.keys(map.baseStores);
      const counts = await Promise.all(names.map((n) => db.table(n).count() as Promise<number>));
      const total = counts.reduce((a, b) => a + b, FRESH_INSTALL);
      return total === FRESH_INSTALL
        ? ok(FRESH_INSTALL)
        : err(ledgeError('E_CORRUPT_STORE', { site: 'migrate-probe', raw: 'unstamped-nonempty' }));
    } finally {
      db.close();
    }
  };

  const migrate = async (): Promise<Result<MigrationReport, LedgeError>> => {
    const probed = await probeCurrent();
    if (!probed.ok) return probed;
    const current = probed.value;

    if (current !== FRESH_INSTALL && current > target) {
      // Never silently open a newer database (engine open() law extended here).
      return err(
        ledgeError('E_MIGRATION', { site: 'migrate-probe', raw: 'ahead-of-map', current, target }),
      );
    }
    if (current === target && current !== FRESH_INSTALL) {
      return ok({
        kind: 'no-op',
        fromVersion: current,
        toVersion: target,
        stepsApplied: [],
        checkpointed: false,
      });
    }

    // ADR-034 law 1: checkpoint BEFORE any byte is touched — but only when
    // there are bytes worth restoring (an existing database being advanced).
    const advancing = current !== FRESH_INSTALL && current < target;
    let checkpointed = false;
    if (advancing) {
      const capability: CheckpointCapability | undefined = deps.checkpoint;
      if (capability === undefined) {
        return err(
          ledgeError('E_MIGRATION', {
            site: 'migrate-checkpoint',
            raw: 'checkpoint-capability-absent',
            current,
            target,
          }),
        );
      }
      const stamped = await capability();
      if (!stamped.ok) {
        // Refusal (e.g. E_JOURNAL_INTEGRITY over suspect bytes) aborts the
        // migration untouched — the conservative-recovery law outranks progress.
        return err(stamped.error);
      }
      checkpointed = true;
    }

    // Laws 2+3: transforms and invariant assertions inside the versionchange
    // transaction. On throw the platform restores the checkpoint-era bytes.
    // The committed world's stamp is verified on the SAME handle (ADR-034:
    // assert the world we built) — no third open is spent on post-verification.
    let committedStamp: unknown;
    try {
      const db = await openChain(target, true);
      try {
        const stamped = (await db.table('meta').get(META_SCHEMA_KEY)) as
          { readonly value?: unknown } | undefined;
        committedStamp = stamped?.value;
        if (current === FRESH_INSTALL && stamped === undefined) {
          // Fresh-path stamp law: the probe open already created the physical
          // database at base version, so no upgrade callback fires on a
          // steps-empty map and nothing else would write the version integer.
          // (§2.9: the integer has no lawful gap case.)
          await db.table('meta').put({ key: META_SCHEMA_KEY, value: target });
          committedStamp = target;
        }
      } finally {
        db.close();
      }
    } catch (e) {
      const unwrapped = unwrapViolation(e);
      return err(
        ledgeError('E_MIGRATION', {
          site: 'migrate-upgrade',
          raw: unwrapped.name,
          current,
          target,
          ...(unwrapped.facts ?? {}),
        }),
      );
    }

    if (committedStamp !== target) {
      return err(
        ledgeError('E_MIGRATION', {
          site: 'migrate-verify',
          raw: 'stamp-missing',
          current,
          target,
        }),
      );
    }

    return ok({
      kind: current === FRESH_INSTALL ? 'fresh-install' : 'migrated',
      fromVersion: current,
      toVersion: target,
      // Probe-before-open has already created a fresh database, so from a
      // fresh start every step runs; on an upgrade only steps > current run.
      stepsApplied: map.steps.filter((s) => s.to > current).map((s) => s.to),
      checkpointed,
    });
  };

  const snapshot = async (
    throughVersion?: number,
  ): Promise<Result<Readonly<Record<string, readonly MigrationRecord[]>>, LedgeError>> => {
    const asked = throughVersion ?? target;
    const version = asked > target ? target : asked;
    let db: Dexie;
    try {
      db = await openChain(version, false);
    } catch (e) {
      return err(mapStorageError(e, 'open'));
    }
    try {
      const image: Record<string, readonly MigrationRecord[]> = {};
      for (const store of storeNamesThrough(map, version)) {
        image[store] = (await db.table(store).toArray()) as readonly MigrationRecord[];
      }
      return ok(image);
    } catch (e) {
      return err(mapStorageError(e, 'txn'));
    } finally {
      db.close();
    }
  };

  return { migrate, snapshot };
}
