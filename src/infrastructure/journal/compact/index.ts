// Public surface of infrastructure/journal/compact (E2-T11 — see types.ts law table).
export { compactJournal, type CompactorDeps } from './compactor.js';
export {
  CHUNK_SEGMENTS_DEFAULT,
  EMPTY_EXCLUDED_DIGEST,
  EXCLUDED_SAMPLE_CAP,
  chunkWindow,
  digestOfExcludedIds,
  digestOfPlan,
  excludeEntries,
  foldExcludedInto,
  payloadMatchesId,
  windowSegments,
} from './policy.js';
export type {
  CompactionBaseline,
  CompactionPlan,
  CompactionReport,
  ExcludedMatch,
  PurgeChainRef,
} from './types.js';
