// Public surface of infrastructure/storage (Blueprint §2.7, E1-T09, E2-T04).
// Dexie is quarantined here (D-03); nothing outside this directory may import it.
export { SCHEMA_VERSION_V1 } from './schema/schema.v1.js';
export { mapStorageError } from './error-map.js';
export type { FailureSite } from './error-map.js';
export { createDexieStorageEngine, DEFAULT_DB_NAME, META_SCHEMA_KEY } from './dexie-engine.js';
export type { DexieEngineDeps } from './dexie-engine.js';
export { createMigrationRunner, PRODUCTION_VERSION_MAP } from './migrations/runner.js';
export {
  requireStoreCounts,
  requireReferential,
  INVARIANT_VIOLATION_NAME,
} from './migrations/invariants.js';
export type {
  CheckpointCapability,
  MigrationInvariant,
  MigrationKind,
  MigrationRecord,
  MigrationReport,
  MigrationRunner,
  MigrationRunnerDeps,
  MigrationStep,
  MigrationStoreAccess,
  MigrationTransform,
  VersionMap,
} from './migrations/types.js';
