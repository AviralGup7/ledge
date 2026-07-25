// Public surface of infrastructure/recovery/marker (E2-T07 — ADR-007 §4 crash
// detection without a shutdown hook, EES-R16 update-vs-crash disambiguation,
// Blueprint §6.2/§6.7 boot path + §14.4-style card gating).
export { classifyBoot, copyKeyFor } from './classify.js';
export {
  stampInstallMarker,
  bootMarkerSequence,
  readAliveMarker,
  readInstallMarker,
  readBootMarker,
} from './lifecycle.js';
export type { InstallDetails, BootMarkerDeps } from './lifecycle.js';
export { MARKER_KEYS, MARKER_SCHEMA_V } from './types.js';
export type {
  AliveMarker,
  BootCause,
  BootMarker,
  BootSignal,
  BootSignalSection,
  ClassifyInput,
  InstallMarker,
  InstallReason,
  RecoveryCopyKey,
} from './types.js';
