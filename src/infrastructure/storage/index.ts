// Public surface of infrastructure/storage (Blueprint §2.7, E1-T09).
// Dexie is quarantined here (D-03); nothing outside this directory may import it.
export { SCHEMA_VERSION_V1 } from './schema/schema.v1.js';
export { mapStorageError } from './error-map.js';
export type { FailureSite } from './error-map.js';
export { createDexieStorageEngine } from './dexie-engine.js';
export type { DexieEngineDeps } from './dexie-engine.js';
