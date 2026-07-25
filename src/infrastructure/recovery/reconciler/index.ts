// Public surface of infrastructure/recovery/reconciler (E2-T06 — ADR-011 boot
// reconciliation, EES §2.13 conservative law, §10-R2 race law, Blueprint §5).
export { reconcileBoot, assessLossRisk } from './reconciler.js';
export {
  policyFor,
  scopeTabRefs,
  buildEvidenceCompletion,
  buildConservativeAbort,
  FAMILY_POLICIES,
  REASON,
} from './policies.js';
export type { FamilyPolicy, IntentFamily } from './policies.js';
export { scanDeviceEvidence, trailFor } from './evidence.js';
export type { CloseObservation, DeviceEvidence, IntentEventTrail } from './evidence.js';
export type {
  BootOutcome,
  BootReport,
  EvidenceKey,
  IntentDisposition,
  IntentResolution,
  JournalProbeReport,
  ProjectionsBootReport,
  ReconcilerDeps,
  StaleClass,
} from './types.js';
export { RECONCILE_REPORT_SCHEMA_V } from './types.js';
