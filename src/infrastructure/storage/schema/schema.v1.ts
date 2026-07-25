// E1-T09 · EES §5 schema v1 (frozen) — store names, primary keys, secondary indexes.
// Index column of EES §5 transcribed 1:1 into Dexie schema syntax. Notes where the
// table's prose needed a concrete mechanical reading:
//  * events "(deviceId,seq)" → compound [deviceId+seqStart]; seqStart is the segment's
//    lowest seq, so a (deviceId, seq) point lookup resolves via the containing segment
//    (segmentRef) — journal design confirms in E2-T01 (ADR-004).
//  * memory_artifacts "derivedFromSeqRange" range {from,to} → dotted key-path index on
//    the range end serves die-with-source purge-chain evaluation (§5 retention column).
//  * delta_ring "watermark desc" → ascending IDB index; desc is a cursor direction.
//  * ai_jobs "subjectKey(unique active)" is a queue-level law, not an IDB constraint —
//    IDB cannot express conditional uniqueness; plain index (Tier-3 queue enforces).
// Adding an index or store later = schema v2 + migration (ADR-034); v1 is immutable.
import type { StoreName } from '@/application/ports/storage-stores.catalog.js';

export const SCHEMA_VERSION_V1 = 1;

/** Dexie per-store schema spec, keyed by the EES §5 store registry names. */
export const SCHEMA_V1: Readonly<Record<StoreName, string>> = {
  events: 'segmentId, [deviceId+seqStart]',
  intents: 'intentId, state',
  missions: 'missionId, state, lastActiveAt, [state+lastActiveAt]',
  tabs: 'ledgeTabId, missionId, state, urlCanonHash, domain, [state+lastActiveAt], deletedAt',
  sessions: '[snapshotId+partIndex], [missionId+takenAt]',
  recently_closed: 'entryId, closedAt',
  memory_artifacts: 'artifactId, [subjectId+kind], kind, derivedFromSeqRange.to',
  search_index: 'token',
  dupe_index: 'canonHash',
  settings: 'key',
  ai_jobs: 'jobId, state, lane, subjectKey',
  logs: 'slot',
  favicons: 'domainHash',
  delta_ring: 'ringId, watermark',
  meta: 'key',
};
