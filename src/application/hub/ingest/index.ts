// Public surface of application/hub/ingest (E2-T05 — Blueprint line 334/618).
export { createIngestHub } from './ingest-hub.js';
export type { IngestHubDeps } from './ingest-hub.js';
export { createTabIdentityMap } from './identity-map.js';
export type { IdentityResolution, TabIdentityMap } from './identity-map.js';
export { createBatcher } from './batcher.js';
export type { Batcher, BatcherDeps } from './batcher.js';
export type {
  FirstRunReport,
  FlushReport,
  GroupChangedInput,
  HydrationSummary,
  IngestCounters,
  IngestDraft,
  IngestHub,
  IngestHubStats,
  IngestReport,
  IngestScheduler,
  PendingObservation,
} from './types.js';
export { INGEST_BATCH_CAP, INGEST_BATCH_WINDOW_MS, INGEST_ACK_TIMEOUT_MS } from './types.js';
