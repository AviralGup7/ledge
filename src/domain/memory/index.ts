// Public surface of domain/memory (E8-T01 · Blueprint §2.2 row: artifact shape
// validation, confidence→presentation tier mapping, purge-chain rules). Pure
// functions only — the domain-is-an-island law (A-01) means no ports here.
export {
  CONFIDENCE_TIER_HIGH_AT,
  CONFIDENCE_TIER_MEDIUM_AT,
  confidencePresentation,
  confidenceTier,
  presentationForTier,
} from './confidence.js';
export type { ConfidencePresentation, ConfidenceTier } from './confidence.js';
export { validateArtifactCandidate } from './artifact.js';
export type {
  ArtifactRejectClass,
  ArtifactValidation,
  MemoryArtifactCandidate,
} from './artifact.js';
export { briefsGate } from './brief-gate.js';
export type { BriefGateArtifact, BriefGateDecision } from './brief-gate.js';
export {
  NUDGE_DAILY_CAP,
  NUDGE_DISMISS_FOREVER_COUNT,
  NUDGE_DISMISS_SUPPRESS_MS,
  localMidnightFloor,
  nudgeWindow,
} from './nudge-timing.js';
export type { NudgeDismissalMemory, NudgeWindowDecision } from './nudge-timing.js';
