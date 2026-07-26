// E5-T06 · Import-bytes stage — the v1 frame of the frozen C20 "bytes move
// through the workroom streaming contract" comment (user-ruled; ADR note
// docs/adr-notes/e5-import-preview-ui.md). A shared-origin IndexedDB shelf: the
// quiet page stages file bytes, the frozen wire carries fileMeta only, and the
// SW claims the shelf at preview time. Laws (port-pinned): ONE pending slot
// (last write wins — the panel serializes previews deliberately), claim-on-read
// (a consumed slot never answers twice), name/size consistency is the caller's
// lie detector, TTL-bounded residue (C25: staged bytes are consumables, never
// archives). Raw IDB, zero deps: importable from BOTH the SW root and a surface
// root without dragging an engine in (depcruise: importers/exporters never
// touch journal|storage infrastructure).
import type {
  ImportBytesStagePort,
  StagedImportBytes,
} from '@/application/ports/import-export.port.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { Now } from '@/shared-kernel/identity/index.js';

/** Staged bytes outlive a crashed preview by minutes, never by sessions. */
export const IMPORT_STAGE_TTL_MS = 900_000; // 15 min
export const IMPORT_STAGE_DB = 'ledge-import-stage';
const STORE = 'pending';
const SLOT_KEY = 'latest';
const DB_VERSION = 1;
const STAGE_OP = 'ImporterBytesStage';

const isQuota = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  (cause as { name?: unknown }).name === 'QuotaExceededError';

const stageError = (what: string, cause: unknown): LedgeError =>
  isQuota(cause)
    ? ledgeError('E_QUOTA', { what: `${STAGE_OP}:${what}` })
    : ledgeError('E_CORRUPT_STORE', { what: `${STAGE_OP}:${what}`, cause: String(cause) });

interface SlotRow extends StagedImportBytes {
  readonly slot: typeof SLOT_KEY;
}

export interface ImportBytesStageDeps {
  /** Injectable for the unit lane (fake-indexeddb); platform in roots. */
  readonly idb: IDBFactory;
  readonly now: Now;
}

const openDb = (idb: IDBFactory): Promise<Result<IDBDatabase, LedgeError>> =>
  new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(IMPORT_STAGE_DB, DB_VERSION);
    } catch (cause) {
      resolve(err(stageError('open-throw', cause)));
      return;
    }
    req.onerror = () => resolve(err(stageError('open', req.error)));
    req.onblocked = () => resolve(err(stageError('open', 'blocked')));
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'slot' });
    };
    req.onsuccess = () => resolve(ok(req.result));
  });

/** One request inside one txn; the db closes on settlement. */
const request = <T>(
  idb: IDBFactory,
  mode: IDBTransactionMode,
  what: string,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<Result<T, LedgeError>> =>
  openDb(idb).then((db) => {
    if (!db.ok) return err(db.error);
    return new Promise<Result<T, LedgeError>>((resolve) => {
      const done = (r: Result<T, LedgeError>): void => {
        db.value.close();
        resolve(r);
      };
      let req: IDBRequest<T>;
      try {
        req = run(db.value.transaction(STORE, mode).objectStore(STORE));
      } catch (cause) {
        done(err(stageError(`${what}-throw`, cause)));
        return;
      }
      req.onerror = () => done(err(stageError(what, req.error)));
      req.onsuccess = () => done(ok(req.result));
    });
  });

export const createImportBytesStage = (deps: ImportBytesStageDeps): ImportBytesStagePort => {
  const readSlot = (): Promise<Result<SlotRow | undefined, LedgeError>> =>
    request(
      deps.idb,
      'readonly',
      'read',
      (store) => store.get(SLOT_KEY) as IDBRequest<SlotRow | undefined>,
    );

  const deleteSlot = (): Promise<Result<undefined, LedgeError>> =>
    request(deps.idb, 'readwrite', 'delete', (store) => store.delete(SLOT_KEY));

  const expired = (row: StagedImportBytes): boolean =>
    deps.now() - row.stagedAt > IMPORT_STAGE_TTL_MS;

  return {
    put: async (input) => {
      // Single-slot law: a new staging replaces whatever was pending — at most
      // one residue row can ever exist, so sweep pressure stays O(1).
      const row: SlotRow = {
        slot: SLOT_KEY,
        name: input.name,
        size: input.size,
        stagedAt: deps.now(),
        bytes: input.bytes,
      };
      const written = await request(deps.idb, 'readwrite', 'put', (store) => store.put(row));
      if (!written.ok) return err(written.error);
      return ok({ staged: true as const });
    },

    takeMatching: async (meta) => {
      const row = await readSlot();
      if (!row.ok) return err(row.error);
      if (row.value === undefined) return ok(undefined);
      // Claim-on-read: the slot is consumed whatever the verdict — TTL-dead or
      // mismatched bytes must never answer a later, different request.
      const gone = await deleteSlot();
      if (!gone.ok) return err(gone.error);
      if (expired(row.value)) return ok(undefined);
      if (row.value.name !== meta.name || row.value.size !== meta.size) return ok(undefined);
      return ok({
        name: row.value.name,
        size: row.value.size,
        stagedAt: row.value.stagedAt,
        bytes: row.value.bytes,
      });
    },

    sweep: async () => {
      const row = await readSlot();
      if (!row.ok) return err(row.error);
      if (row.value === undefined || !expired(row.value)) return ok({ swept: 0 });
      const gone = await deleteSlot();
      if (!gone.ok) return err(gone.error);
      return ok({ swept: 1 });
    },
  };
};
