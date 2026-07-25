// E1-T09 · EES §6 StorageEnginePort — the sole seam between Ledge and IndexedDB (ADR-013).
// Implemented only by src/infrastructure/storage (Dexie quarantine D-03). Consumers are the
// durable-write family (journal/storage/recovery/projections) plus application orchestration —
// never chrome adapters, AI, importers, or surfaces (writer-concentration, ADR-005).
//
// EES §5 global storage laws encoded in this seam:
//  (1) All multi-record mutations in a single txn — the API has no ambient write handle;
//      every write is scoped to txn(scope, 'readwrite', work) so atomicity is structural.
//  (2) Journal/intent durability hinge — one txn may span any store subset incl. events+intents.
//  (unknown-field law) StoreHandle.put stores records verbatim via structured clone — the
//      adapter performs no field mapping, so unknown fields round-trip preserved by
//      construction (contract-proven against ops/fixtures/storage/unknown-field.golden.json).
//
// Method inventory per §6: txn(scope[],mode) · typed store CRUD · quota() · persist().
// migrate(version,map) and the N-1→N fixture suite land with the migration runner (E2-T04).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { StoreName } from './storage-stores.catalog.js';

export type { StoreName } from './storage-stores.catalog.js';

/** IDB transaction modes. 'readwrite' required for any mutation. */
export type TxnMode = 'readonly' | 'readwrite';

/**
 * Records are plain structured-cloneable objects. The engine is record-type-generic:
 * per-store shapes (journal segments, projections, recovery markers) are owned by their
 * respective modules and bound via the generic parameter at the call site.
 */
export type StoredRecord = Readonly<Record<string, unknown>>;

/** Valid IDB primary keys for Ledge stores: string, numeric ring slots, compound tuples. */
export type StorageKey = string | number | ReadonlyArray<string | number>;

/** Value an index range matches against — same domain as StorageKey. */
export type IndexBound = StorageKey;

/**
 * Secondary-index query. `name` must be an index declared for the store in the schema
 * (compound indexes are addressed by their '[a+b]' schema name). EES §2.9's no-scan-path
 * law is structural here: the only range-read API is index-addressed, so a query that
 * would fall back to a table scan cannot be expressed.
 */
export type IndexRangeQuery =
  | { readonly kind: 'equals'; readonly name: string; readonly value: IndexBound }
  | {
      readonly kind: 'between';
      readonly name: string;
      readonly lower: IndexBound;
      readonly upper: IndexBound;
    };

export interface StoreHandle<R extends StoredRecord> {
  /** Primary-key lookup. Absent record → undefined (never throws). */
  get(key: StorageKey): Promise<R | undefined>;
  getMany(keys: readonly StorageKey[]): Promise<ReadonlyArray<R | undefined>>;
  /** Insert or replace by primary key (inbound-key schema; record carries its pk field). */
  put(record: R): Promise<void>;
  putMany(records: readonly R[]): Promise<void>;
  delete(key: StorageKey): Promise<void>;
  deleteMany(keys: readonly StorageKey[]): Promise<void>;
  /**
   * Full primary-index walk in key order. Chunk-size is caller discipline (rebuild,
   * compaction, migration fixtures). Primary-index scans are index-covered; EES §2.9's
   * no-scan-path law bans non-indexed queries, not ordered primary walks.
   */
  toArray(): Promise<readonly R[]>;
  /** Secondary-index read in ascending index order (see IndexRangeQuery's law note). */
  byIndex(query: IndexRangeQuery): Promise<readonly R[]>;
  count(): Promise<number>;
}

/** Transaction scope: typed CRUD over exactly the stores declared in txn(scope). */
export interface TxScope {
  table<R extends StoredRecord>(name: StoreName): StoreHandle<R>;
}

export interface QuotaStatus {
  /** false when navigator.storage is unavailable (tests, exotic embedders). */
  readonly apiAvailable: boolean;
  readonly persisted: boolean;
  readonly usageBytes?: number | undefined;
  readonly quotaBytes?: number | undefined;
  /** usage/quota in [0,1]; undefined when either side is unknown. §5 law 6 probes <0.8. */
  readonly pressureRatio?: number | undefined;
}

export interface StorageEnginePort {
  /**
   * Open (idempotent). Stamps the schema-version integer into `meta` on first use and
   * asserts it on every open (§2.9: version integer in meta). A meta version this engine
   * does not understand → E_MIGRATION (checkpoint-restored path never silently opens a
   * newer store; ADR-034). Open-time integrity failure → E_CORRUPT_STORE (rescue path).
   */
  open(): Promise<Result<void, LedgeError>>;
  /**
   * Run `work` inside one IDB transaction spanning `scope`. Any throw/Result-err
   * propagated out of `work` aborts the transaction — nothing commits (§5 law 1).
   * Errors are mapped per ADR-026: E_QUOTA, E_CORRUPT_STORE, E_MIGRATION.
   */
  txn<T>(
    scope: readonly StoreName[],
    mode: TxnMode,
    work: (tx: TxScope) => Promise<T>,
  ): Promise<Result<T, LedgeError>>;
  /** Quota probe per §5 global law 6. Unavailable API is a value, not a failure. */
  quota(): Promise<Result<QuotaStatus, LedgeError>>;
  /**
   * Request durable persistence (first-run law, §5 law 6). Result value = granted.
   * Denial is a valid answer (false), not an error — storage still works, eviction
   * merely becomes possible and health checks must know.
   */
  persist(): Promise<Result<boolean, LedgeError>>;
  /** Schema version integer as stamped in `meta` (undefined before first open). */
  schemaVersion(): Promise<Result<number, LedgeError>>;
  /** Close the database handle. Re-open via open(); close never loses durable bytes. */
  close(): Promise<void>;
}
