// Public surface of infrastructure/ai (E8-T01 · ADR-041's isolated Memory-family
// package). Exports the queue, the ladder, hosts, and rung-1 providers; imports
// are constitutionally confined (shared-kernel · domain/memory · application
// PORT TYPES) — the ai-cannot-mutate depcruise rule is the build-time proof.
export {
  createAiJobQueue,
  JOB_BEAT_MS,
  JOB_LEASE_MS,
  JOB_MAX_CLAIMS,
  JOB_RETRY_CLAIMS,
  subjectKeyFor,
} from './job-queue.js';
export type { AiJobQueueDeps } from './job-queue.js';
export {
  BREAKER_COOLDOWN_MS,
  BREAKER_OPEN_AT_FAILURES,
  createAiLadder,
  PROVIDER_MATRIX_V,
} from './ladder.js';
export type { AiLadder, AiProviderPort, BreakerState, ProviderBreakerReport } from './ladder.js';
export {
  createSwLocalWorkerHost,
  createWorkroomHostPair,
  WORKROOM_EVENT_NAMES,
} from './worker-hosts.js';
export type {
  AiWorkerHost,
  ExecuteOutcome,
  WorkroomPair,
  WorkroomWireDeps,
} from './worker-hosts.js';
export {
  buildHeuristicMissionName,
  createHeuristicNamer,
  formatLabelTime,
  HEURISTIC_NAMER_CONFIDENCE,
  HEURISTIC_NAMER_MODEL_CLASS,
} from './providers/heuristic/namer.js';
export type { MissionNameInput } from './providers/heuristic/namer.js';
