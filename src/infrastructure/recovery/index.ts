// Public surface of infrastructure/recovery (Blueprint §2.12 — boot reconciliation,
// crash detection, repair drivers). Composition roots bind runBootSequence; W7
// surfaces will consume BootReport via application contracts (E6).
export { runBootSequence } from './sequence.js';
export type { RecoveryBootDeps } from './sequence.js';
export {
  reconcileBoot,
  assessLossRisk,
  scanDeviceEvidence,
  trailFor,
  policyFor,
  scopeTabRefs,
  FAMILY_POLICIES,
  REASON,
  RECONCILE_REPORT_SCHEMA_V,
} from './reconciler/index.js';
export type {
  BootOutcome,
  BootReport,
  IntentDisposition,
  IntentResolution,
  ReconcilerDeps,
  StaleClass,
} from './reconciler/index.js';
export {
  classifyBoot,
  copyKeyFor,
  stampInstallMarker,
  bootMarkerSequence,
  MARKER_KEYS,
  MARKER_SCHEMA_V,
} from './marker/index.js';
export type {
  BootCause,
  BootSignal,
  BootSignalSection,
  InstallReason,
  RecoveryCopyKey,
} from './marker/index.js';
