// Public surface of infrastructure/snapshots (E2-T08 — EES-R5 chunking, EES-R4
// group-style fidelity, §5 'sessions' store + part-completeness probe).
export {
  buildSnapshotPayload,
  chunkRefs,
  partCountOf,
  stylesForPart,
  dedupeRefs,
} from './builder.js';
export { sessionsProjector } from './sessions.projector.js';
export { probeSnapshotIntegrity } from './probe.js';
export type { SnapshotProbeDeps } from './probe.js';
export { readSnapshotPayload } from './payload-schema.js';
export type { SnapshotPayloadView } from './payload-schema.js';
export { planRetention, SNAPSHOT_RETENTION_DAYS } from './retention.js';
export type { SnapshotRetentionInput, SnapshotRetentionPlan } from './retention.js';
export { SNAPSHOT_CHUNK_SIZE, SNAPSHOT_TRIGGERS } from './types.js';
export type {
  GroupStyle,
  SessionPartRow,
  SnapshotBuild,
  SnapshotDiagnostics,
  SnapshotInput,
  SnapshotIntegrityReport,
  SnapshotProbeIssue,
  SnapshotTakenPayload,
  SnapshotTrigger,
} from './types.js';
export { createSnapshotsAdapter } from './snapshots.adapter.js';
export type { SnapshotsAdapterDeps } from './snapshots.adapter.js';
