// E7-T02 · Backend matrix. The harness measures the Truth Engine through BOTH storage
// adapters (mission requirement: fake engines AND Dexie):
//   memory — the in-memory StorageEnginePort (fast; full workload grid runs here)
//   dexie  — createDexieStorageEngine over fake-indexeddb (the IDB-semantics reference)
// Warm-boot scenarios need a CLOSE + REOPEN on the same durable image, so each backend
// exposes a session with reopen(); the memory backend mirrors Dexie's close/reopen
// shape, with its process-lifetime caveat documented at the callsites.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createMemoryStorageEngine } from '@/infrastructure/storage/memory/memory-engine.js';
import { createDexieStorageEngine } from '@/infrastructure/storage/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { BackendName } from './types.js';

/** Fail-loud unwrap shared by every scenario (perf code never degrades silently). */
export type Unwrap = <T>(r: Result<T, LedgeError>, where: string) => T;

export interface Backend {
  readonly name: BackendName;
  engine: StorageEnginePort;
  journal: JournalPort;
  readonly unwrap: Unwrap;
}

export interface BackendSession {
  readonly name: BackendName;
  /** A freshly-opened backend on the session's durable image. */
  readonly open: () => Promise<Backend>;
  /** A freshly-opened backend on a BRAND-NEW image (cold-boot measurement). */
  readonly openFresh: () => Promise<Backend>;
  /** Unopened engine handle on the SAME image as `b` (boot-path measurement). */
  readonly rawFor: (b: Backend) => StorageEnginePort;
  /** Close the current engine and reopen against the SAME image (stable data). */
  readonly reopen: (b: Backend) => Promise<Backend>;
}

let dbCounter = 0;

const uniqueDbName = (): string => {
  dbCounter += 1;
  return `ledge-perf-${dbCounter}`;
};

const unwrapOrThrow: Unwrap = (r, where) => {
  if (!r.ok) throw new Error(`perf harness: ${where} failed: ${r.error.code}`);
  return r.value;
};

const makeBackend = (name: BackendName, engine: StorageEnginePort): Backend => ({
  name,
  engine,
  journal: createJournal(engine),
  unwrap: unwrapOrThrow,
});

/** Fresh session factory per backend name. Dexie gets one IDBFactory per SESSION
 *  (a session's reopens share the database; separate sessions never see each other). */
export const createBackendSession = (name: BackendName): BackendSession => {
  if (name === 'memory') {
    // Parity with the Dexie session: open() is the SESSION'S durable image (shared
    // across calls — warm flows ride it), openFresh() is a brand-new image. Without
    // this parity, per-iteration scenarios appended onto a dirty head on dexie.
    let shared: Backend | null = null;
    const openShared = async (): Promise<Backend> => {
      if (shared === null) {
        const engine = createMemoryStorageEngine();
        unwrapOrThrow(await engine.open(), 'memory.open');
        shared = makeBackend('memory', engine);
      }
      return shared;
    };
    return {
      name,
      open: openShared,
      openFresh: async () => {
        const engine = createMemoryStorageEngine();
        unwrapOrThrow(await engine.open(), 'memory.openFresh');
        return makeBackend('memory', engine);
      },
      rawFor: (b) => b.engine,
      // Memory-engine close() is a no-op on the single in-process image; reopening
      // mirrors the Dexie warm-boot shape (same image, new port surface).
      reopen: async (b) => {
        await b.engine.close();
        unwrapOrThrow(await b.engine.open(), 'memory.reopen');
        return makeBackend('memory', b.engine);
      },
    };
  }
  const factory = new IDBFactory() as unknown as globalThis.IDBFactory;
  const keyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange;
  const databaseName = uniqueDbName();
  const openDexie = async (fac: globalThis.IDBFactory, dbName: string): Promise<Backend> => {
    const engine = createDexieStorageEngine({
      databaseName: dbName,
      indexedDB: fac,
      idbKeyRange: keyRange,
    });
    unwrapOrThrow(await engine.open(), 'dexie.open');
    return makeBackend('dexie', engine);
  };
  return {
    name,
    open: async () => openDexie(factory, databaseName),
    // Cold boot = a database this host has never opened: new factory + new name.
    openFresh: async () =>
      openDexie(new IDBFactory() as unknown as globalThis.IDBFactory, uniqueDbName()),
    rawFor: () =>
      createDexieStorageEngine({ databaseName, indexedDB: factory, idbKeyRange: keyRange }),
    reopen: async (b) => {
      await b.engine.close();
      return openDexie(factory, databaseName);
    },
  };
};
