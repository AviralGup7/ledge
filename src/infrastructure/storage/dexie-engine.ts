// E1-T09 · ADR-013 — the sole Dexie/IndexedDB adapter (D-03 quarantine: this directory).
// Implements StorageEnginePort from application/ports. Records pass through verbatim
// (structured clone) — the unknown-field round-trip law (EES §2.9) holds by construction.
//
// Abort idiom: `work` returns a plain payload; to abort with a typed error, throw the
// LedgeError envelope inside `work` — the engine catches it at the transaction boundary,
// verifies it structurally, and returns it as Result-err. This is Dexie's sanctioned
// abort mechanism used consistently with ADR-026 (the throw never crosses a module
// boundary: it originates and lands inside this adapter's catch).
import { Dexie, type Table } from 'dexie';
import { ok, err, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { ERROR_CODES } from '@/shared-kernel/result/error-codes.catalog.js';
import type {
  QuotaStatus,
  StorageEnginePort,
  StorageKey,
  StoreHandle,
  StoredRecord,
  StoreName,
  TxScope,
  TxnMode,
} from '@/application/ports/storage-engine.port.js';
import { SCHEMA_V1, SCHEMA_VERSION_V1 } from './schema/schema.v1.js';
import { mapStorageError } from './error-map.js';

export interface DexieEngineDeps {
  readonly databaseName?: string;
  /** Test seam: fake-indexeddb injects {indexedDB, idbKeyRange}; production uses globals. */
  readonly indexedDB?: IDBFactory;
  readonly idbKeyRange?: typeof IDBKeyRange;
}

const DEFAULT_DB_NAME = 'ledge';

/** meta store row shape used by this adapter for the §2.9 schema-version integer.
 *  Type alias (not interface) so it stays assignable to StoredRecord's index signature. */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

const META_SCHEMA_KEY = 'schemaV';

/** Structural check — a thrown LedgeError carries our envelope; anything else is foreign. */
const isLedgeError = (e: unknown): e is LedgeError => {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as { code?: unknown; retryable?: unknown; messageKey?: unknown };
  return (
    typeof c.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(c.code) &&
    typeof c.retryable === 'boolean' &&
    typeof c.messageKey === 'string'
  );
};

const makeHandle = <R extends StoredRecord>(table: Table): StoreHandle<R> => ({
  get: (key: StorageKey) => table.get(key) as Promise<R | undefined>,
  getMany: async (keys: readonly StorageKey[]) => {
    // Dexie bulkGet is one IDB request batch, not Promise.all over a live transaction.
    const rows = (await table.bulkGet([...keys])) as unknown[];
    return rows.map((r) => r as R | undefined);
  },
  put: async (record: R) => {
    await table.put(record);
  },
  putMany: async (records: readonly R[]) => {
    await table.bulkPut([...records]);
  },
  delete: async (key: StorageKey) => {
    await table.delete(key);
  },
  deleteMany: async (keys: readonly StorageKey[]) => {
    await table.bulkDelete([...keys]);
  },
  toArray: () => table.toArray() as Promise<readonly R[]>,
  byIndex: async (query) => {
    const where = table.where(query.name);
    const rows =
      query.kind === 'equals'
        ? await where.equals(query.value as Parameters<typeof where.equals>[0]).toArray()
        : await where
            .between(
              query.lower as Parameters<typeof where.between>[0],
              query.upper as Parameters<typeof where.between>[1],
              true,
              true,
            )
            .toArray();
    return rows as readonly R[];
  },
  count: () => table.count(),
});

export function createDexieStorageEngine(deps: DexieEngineDeps = {}): StorageEnginePort {
  const dexieOpts: { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange } = {};
  if (deps.indexedDB !== undefined) dexieOpts.indexedDB = deps.indexedDB;
  if (deps.idbKeyRange !== undefined) dexieOpts.IDBKeyRange = deps.idbKeyRange;
  const db = new Dexie(
    deps.databaseName ?? DEFAULT_DB_NAME,
    deps.indexedDB === undefined ? undefined : dexieOpts,
  );
  db.version(SCHEMA_VERSION_V1).stores({ ...SCHEMA_V1 });

  let opened = false;

  /** Core transaction path — ungated so open() itself can stamp meta before flipping the flag. */
  const runTxn = async <T>(
    scope: readonly StoreName[],
    mode: TxnMode,
    work: (tx: TxScope) => Promise<T>,
  ): Promise<Result<T, LedgeError>> => {
    try {
      const tables = scope.map((n) => db.table(n));
      const value = await db.transaction(
        mode === 'readwrite' ? 'rw' : 'r',
        tables,
        async (): Promise<T> => {
          const scopeObj: TxScope = {
            table: <R extends StoredRecord>(name: StoreName) => makeHandle<R>(db.table(name)),
          };
          return await work(scopeObj);
        },
      );
      return ok(value);
    } catch (e) {
      // A typed envelope thrown by `work` to force abort surfaces here intact.
      if (isLedgeError(e)) return err(e);
      return err(mapStorageError(e, 'txn'));
    }
  };

  const engine: StorageEnginePort = {
    async open() {
      try {
        await db.open();
      } catch (e) {
        return err(mapStorageError(e, 'open'));
      }
      // §2.9 versioning law: schema-version integer lives in meta; stamp on first use,
      // assert on every open. A foreign version belongs to the migration runner (E2-T04).
      const stamped = await runTxn(['meta'], 'readwrite', async (tx) => {
        const meta = tx.table<MetaRow>('meta');
        const row = await meta.get(META_SCHEMA_KEY);
        if (row === undefined) {
          await meta.put({ key: META_SCHEMA_KEY, value: SCHEMA_VERSION_V1 });
          return SCHEMA_VERSION_V1;
        }
        return row.value;
      });
      if (!stamped.ok) return stamped;
      if (stamped.value !== SCHEMA_VERSION_V1) {
        return err(
          mapStorageError(
            Object.assign(new Error('foreign schema version'), { name: 'VersionError' }),
            'open',
          ),
        );
      }
      opened = true;
      return ok(undefined);
    },

    async txn<T>(
      scope: readonly StoreName[],
      mode: TxnMode,
      work: (tx: TxScope) => Promise<T>,
    ): Promise<Result<T, LedgeError>> {
      // §2.9 boot discipline: explicit open() is the deterministic failure surface;
      // ambient use before open is an invariant breach (conservative: corruption-class).
      if (!opened) {
        return err(
          mapStorageError(
            Object.assign(new Error('engine used before open()'), { name: 'NotOpen' }),
            'open',
          ),
        );
      }
      return runTxn(scope, mode, work);
    },

    async quota() {
      const mgr = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (mgr === undefined) {
        return ok<QuotaStatus>({ apiAvailable: false, persisted: false });
      }
      try {
        const [estimate, persisted] = await Promise.all([mgr.estimate(), mgr.persisted()]);
        const usage = estimate.usage;
        const quota = estimate.quota;
        const ratio =
          usage !== undefined && quota !== undefined && quota > 0 ? usage / quota : undefined;
        return ok<QuotaStatus>({
          apiAvailable: true,
          persisted,
          usageBytes: usage,
          quotaBytes: quota,
          pressureRatio: ratio,
        });
      } catch (e) {
        return err(mapStorageError(e, 'quota'));
      }
    },

    async persist() {
      const mgr = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (mgr === undefined) return ok(false);
      try {
        return ok(await mgr.persist());
      } catch (e) {
        return err(mapStorageError(e, 'persist'));
      }
    },

    async schemaVersion() {
      return engine.txn(['meta'], 'readonly', async (tx) => {
        const row = await tx.table<MetaRow>('meta').get(META_SCHEMA_KEY);
        if (row === undefined || typeof row.value !== 'number') {
          throw mapStorageError(
            Object.assign(new Error('schemaV missing after open'), { name: 'MetaInvariant' }),
            'open',
          );
        }
        return row.value;
      });
    },

    async close() {
      db.close();
      opened = false;
    },
  };

  return engine;
}
