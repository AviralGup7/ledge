// E1-T12 · in-memory StorageEnginePort — the second adapter proving ADR-032's parametric
// contract suite, and the stub for application-layer tests (E2 hub onward). TEST-ONLY:
// never imported by composition roots outside tests (WXT tree-shakes it from bundles).
// ADR-013's "sole IDB adapter" binds the shipped extension; this fixture ships nowhere.
//
// Semantics mirrored from the Dexie adapter, faithfully enough for contract law:
//  * schema v1 store set + schemaV stamp/assert on open (EES §2.9)
//  * single-txn atomicity: mutations apply to a working copy, aborted work discards it
//  * byIndex honors the declared index names from SCHEMA_V1 (compound [a+b], dotted a.b)
//  * records pass through verbatim — unknown-field law holds by the same construction
import type {
  IndexBound,
  QuotaStatus,
  StorageEnginePort,
  StorageKey,
  StoreHandle,
  StoredRecord,
  StoreName,
  TxScope,
  TxnMode,
} from '@/application/ports/storage-engine.port.js';
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { STORE_NAMES } from '@/application/ports/storage-stores.catalog.js';
import { SCHEMA_V1, SCHEMA_VERSION_V1 } from '../schema/schema.v1.js';
import { mapStorageError } from '../error-map.js';

type TableData = Map<string, StoredRecord>;

const keyString = (k: StorageKey): string => (Array.isArray(k) ? JSON.stringify(k) : String(k));

// IDB parity: values cross the boundary as structured clones (mutation of the caller's
// reference never leaks into the store, and non-cloneable records fail at put time).
const cloneRecord = <R>(value: R): R => structuredClone(value);

const noIndexError = (indexName: string, store: string): LedgeError =>
  mapStorageError(
    Object.assign(new Error(`undeclared index ${indexName} on ${store}`), { name: 'SchemaError' }),
    'txn',
  );

/** Decode one index token from the Dexie schema string into a value extractor. */
const extractorFor = (token: string): ((record: StoredRecord) => unknown) => {
  if (token.startsWith('[') && token.endsWith(']')) {
    const fields = token.slice(1, -1).split('+');
    return (record) => fields.map((f) => readPath(record, f));
  }
  return (record) => readPath(record, token);
};

const readPath = (record: StoredRecord, path: string): unknown => {
  let cur: unknown = record;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

/** IDB ordering over index values: numbers < strings < arrays; arrays lexicographic. */
const compareIndexValues = (a: unknown, b: unknown): number => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const c = compareIndexValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const RANK_ARRAY = 2; // IDB type ordering: numbers < strings < arrays
  const rank = (v: unknown): number =>
    typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : RANK_ARRAY;
  return rank(a) - rank(b);
};

const asTuple = (v: IndexBound): unknown[] => (Array.isArray(v) ? [...v] : [v]);

export function createMemoryStorageEngine(): StorageEnginePort {
  let opened = false;
  // The durable world: committed tables. txn work mutates a copy (atomic abort).
  const tables = new Map<StoreName, TableData>(STORE_NAMES.map((n) => [n, new Map()]));

  const cloneTables = (src: Map<StoreName, TableData>): Map<StoreName, TableData> =>
    new Map([...src].map(([n, t]) => [n, new Map(t)]));

  const makeHandle = <R extends StoredRecord>(
    storeName: StoreName,
    table: TableData,
  ): StoreHandle<R> => {
    const specTokens = (SCHEMA_V1[storeName] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const pkToken = specTokens[0] ?? 'key';
    const indexTokens = specTokens.slice(1);
    const pkExtract = extractorFor(pkToken);
    const handle: StoreHandle<R> = {
      get: (key: StorageKey) => {
        const v = table.get(keyString(key));
        return Promise.resolve(v === undefined ? undefined : (cloneRecord(v) as R));
      },
      getMany: (keys: readonly StorageKey[]) =>
        Promise.resolve(
          keys.map((k) => {
            const v = table.get(keyString(k));
            return v === undefined ? undefined : (cloneRecord(v) as R);
          }),
        ),
      put: (record: R) => {
        const pkValue = pkExtract(record);
        if (pkValue === undefined) {
          throw new Error(`record missing primary key ${pkToken} on ${storeName}`);
        }
        table.set(keyString(pkValue as StorageKey), cloneRecord(record) as StoredRecord);
        return Promise.resolve();
      },
      putMany: async (records: readonly R[]) => {
        for (const r of records) await handle.put(r);
      },
      delete: (key: StorageKey) => {
        table.delete(keyString(key));
        return Promise.resolve();
      },
      deleteMany: (keys: readonly StorageKey[]) => {
        for (const k of keys) table.delete(keyString(k));
        return Promise.resolve();
      },
      toArray: () =>
        Promise.resolve(
          [...table.values()].sort((a, b) =>
            compareIndexValues(pkExtract(a), pkExtract(b)),
          ) as readonly R[],
        ),
      byIndex: (query) => {
        if (!indexTokens.includes(query.name)) return noIndexThrow(query.name, storeName);
        const extract = extractorFor(query.name);
        const rows = [...table.values()]
          .filter((record) => {
            const v = extract(record);
            if (v === undefined) return false; // absent field ⇒ no index entry (IDB semantics)
            if (query.kind === 'equals') {
              return compareIndexValues(asTuple(v as IndexBound), asTuple(query.value)) === 0;
            }
            return (
              compareIndexValues(asTuple(v as IndexBound), asTuple(query.lower)) >= 0 &&
              compareIndexValues(asTuple(v as IndexBound), asTuple(query.upper)) <= 0
            );
          })
          .sort((a, b) =>
            compareIndexValues(
              asTuple(extract(a) as IndexBound),
              asTuple(extract(b) as IndexBound),
            ),
          );
        return Promise.resolve(rows.map((r) => cloneRecord(r)) as readonly R[]);
      },
      count: () => Promise.resolve(table.size),
    };
    return handle;
  };

  const noOpenError = (): Result<never, LedgeError> => ({
    ok: false,
    error: mapStorageError(
      Object.assign(new Error('engine used before open()'), { name: 'NotOpen' }),
      'open',
    ),
  });

  const engine: StorageEnginePort = {
    async open() {
      const meta = tables.get('meta');
      if (meta === undefined) {
        return {
          ok: false,
          error: mapStorageError(
            Object.assign(new Error('meta store missing'), { name: 'MemoryInvariant' }),
            'open',
          ),
        };
      }
      const stamped = meta.get(META_SCHEMA_KEY)?.['value'];
      if (stamped === undefined) {
        meta.set(META_SCHEMA_KEY, { key: META_SCHEMA_KEY, value: SCHEMA_VERSION_V1 });
      } else if (stamped !== SCHEMA_VERSION_V1) {
        return {
          ok: false,
          error: mapStorageError(
            Object.assign(new Error('foreign schema version'), { name: 'VersionError' }),
            'open',
          ),
        };
      }
      opened = true;
      return ok(undefined);
    },

    async txn<T>(
      scope: readonly StoreName[],
      mode: TxnMode,
      work: (tx: TxScope) => Promise<T>,
    ): Promise<Result<T, LedgeError>> {
      if (!opened) return noOpenError();
      const working = mode === 'readwrite' ? cloneTables(tables) : tables;
      const scopeObj: TxScope = {
        table: <R extends StoredRecord>(name: StoreName) => {
          const t = working.get(name);
          if (t === undefined)
            throw mapStorageError(
              Object.assign(new Error(`unknown store ${name}`), { name: 'SchemaError' }),
              'txn',
            );
          return makeHandle<R>(name, t);
        },
      };
      try {
        const value = await work(scopeObj);
        if (mode === 'readwrite') {
          for (const [name, data] of working) tables.set(name, data);
        }
        return ok(value);
      } catch (e) {
        return { ok: false, error: mapMemoryError(e) };
      }
    },

    quota: () => Promise.resolve(ok<QuotaStatus>({ apiAvailable: false, persisted: false })),
    persist: () => Promise.resolve(ok(false)),

    async schemaVersion() {
      return engine.txn(['meta'], 'readonly', async (tx) => {
        const row = await tx.table<{ key: string; value: unknown }>('meta').get(META_SCHEMA_KEY);
        if (row === undefined || typeof row.value !== 'number') {
          throw mapStorageError(
            Object.assign(new Error('schemaV missing after open'), { name: 'MetaInvariant' }),
            'open',
          );
        }
        return row.value;
      });
    },

    close: () => {
      opened = false;
      return Promise.resolve();
    },
  };

  return engine;
}

const META_SCHEMA_KEY = 'schemaV';

const mapMemoryError = (e: unknown): LedgeError => {
  if (typeof e === 'object' && e !== null && 'code' in e && 'messageKey' in e) {
    return e as LedgeError; // our own envelope thrown to abort
  }
  return mapStorageError(e, 'txn');
};

function noIndexThrow(indexName: string, store: string): never {
  throw noIndexError(indexName, store);
}
