// E1-T09 · ADR-032 binding — the contract suite against the Dexie adapter.
// A fresh in-memory IDBFactory per engine instance gives per-test isolation with
// production-identical IDB semantics (fake-indexeddb is the Dexie-tested shim).
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDexieStorageEngine } from '@/infrastructure/storage/index.js';
import { describeStorageEngineContract } from './storage-engine.contract.js';

describeStorageEngineContract('dexie', () =>
  createDexieStorageEngine({
    indexedDB: new IDBFactory() as unknown as globalThis.IDBFactory,
    idbKeyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
  }),
);
