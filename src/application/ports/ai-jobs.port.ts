// E8-T01 · EES §2.12 AiJobQueuePort — the durable AI job pipeline seam. Implemented
// in infrastructure/ai (the isolated Memory-family package, ADR-041); consumed ONLY
// by the application AI-jobs service. Types are deliberately READ-ONLY evidence:
// jobs and artifacts can describe work and carry results, but no mutation-capable
// symbol exists in this contract (ADR-017 law 1 — output typing).
//
// Laws encoded at this seam (EES §2.12 constitutional invariants):
//  * EXACTLY-ONCE ARTIFACT PER JOB — lease + completion marker under the job key;
//    the terminal write is executed by the queue inside the application's hinged
//    journal commit (§5 law 2), and it ABORTS the whole commit on duplicate.
//  * DURABLE + COALESCING + IDEMPOTENT (ADR-017 law 2) — same subject+state hash
//    ⇒ the same job; enqueue of a live duplicate returns the existing jobId.
//  * LANES: interactive > maintenance > background; background claims only inside
//    caller-p proven idle+battery windows (Blueprint §10 scheduling doctrine).
//  * RETRY ×2 THEN LANE-FALLBACK (Blueprint §9 row 6): claims beyond the retry
//    budget run with the ladder force-collapsed to the heuristic rung; a failure
//    there is terminal.
//  * MALFORMED ⇒ REJECT + COUNT (EES §2.12 failure law) — rejections are queue
//    statistics (probe-visible), never silent, never shipped.
import type { MessageEnvelope } from '@/application/contracts/envelope.js';
import type { ValidatedMessage } from '@/application/contracts/validate.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { OffscreenPort } from '@/application/ports/offscreen.port.js';
import type { TxScope } from './storage-engine.port.js';

/** §3.6/ADR-017 lane vocabulary (priority order equals array order). */
export const AI_LANES = ['interactive', 'maintenance', 'background'] as const;
export type AiLane = (typeof AI_LANES)[number];

/** Job kind vocabulary (ADR-017: new capability = new job type + provider binding).
 *  E8-T01 ships 'mission-name' (Spec §6.1, EES-R 7.1 interactive rename ≤2.5s path);
 *  E8-T04+ extends (summary, topics, links…). */
export type AiJobKind = 'mission-name';

export type AiJobState = 'queued' | 'claimed' | 'done' | 'failed';

/** Terminal failure classes (counted, probe-visible — never silent). */
export type AiFailureClass =
  | 'provider-error' // provider threw/errored inside the worker
  | 'timeout' // job exceeded its deadline (deadlineMs law)
  | 'worker-lost' // host died/disappeared mid-job (lease reclaimed path)
  | 'malformed-artifact' // boundary shape missing (§2.12 pre-write reject)
  | 'artifact-invalid' // well-shaped but law-breaking content (domain validation)
  | 'attempts-exhausted'; // retry budget + forced-heuristic final all consumed

/** The durable ai_jobs row (EES §5 frozen shape + additive fields law):
 *  {kind,subjectKey(=hash(kind,subject,stateHash)),payloadRef,lane,state,attempts,
 *   lease{workerTag,expires},artifactRef?} — additive stamps (createdAt/updatedAt/
 *  enqueuedAtSeq/failureClass/completedAt) record-side only; indexes unchanged. */
export interface AiJobRow {
  readonly jobId: string;
  readonly kind: AiJobKind;
  readonly subjectKey: string;
  readonly payloadRef: AiPayloadRef;
  readonly lane: AiLane;
  readonly state: AiJobState;
  readonly attempts: number;
  readonly lease: { readonly workerTag: string; readonly expiresAt: number } | null;
  readonly artifactRef?: string | undefined;
  readonly forceHeuristic?: boolean | undefined;
  readonly failureClass?: AiFailureClass | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Journal head seq observed at enqueue — artifact derivedFromSeqRange.from. */
  readonly enqueuedAtSeq: number;
  readonly completedAt?: number | undefined;
}

/** Job payload envelope — the worker input rides inline (subject references stay
 *  references; content payloads honor §3.1 size law like every wire payload). */
export interface AiPayloadRef {
  readonly subjectId: string;
  readonly input: unknown;
  /** fnv1a64 over stableStringify(input) — the stateHash leg of subjectKey. */
  readonly stateHash: string;
}

export interface AiEnqueueInput {
  readonly kind: AiJobKind;
  readonly subjectId: string;
  readonly lane: AiLane;
  readonly input: unknown;
}

export interface AiEnqueueOutcome {
  readonly jobId: string;
  /** true when an existing live job answered (coalescing law — no duplicate enqueued). */
  readonly coalesced: boolean;
}

/** Claim-admission result: null = no runnable job in the admitted lanes. */
export type AiClaim = AiJobRow;

/** Per-lane depth rows for §12's ai-lanes probe (lane depths + breaker states). */
export interface AiLaneDepth {
  readonly lane: AiLane;
  readonly queued: number;
  readonly claimed: number;
  readonly done: number;
  readonly failed: number;
}

export interface AiQueueStats {
  readonly lanes: readonly AiLaneDepth[];
  readonly malformedRejected: number;
  readonly invalidRejected: number;
  /** Terminal rows older than the retention horizon (candidate purge backlog). */
  readonly terminalOverRetention: number;
}

/** Terminal-write input — executed by the queue inside the application's hinged
 *  journal commit so the artifact event and the completion marker share ONE fate. */
export interface AiTerminalWrite {
  readonly jobId: string;
  readonly artifactId: string;
  readonly workerTag: string;
}

export interface AiJobQueuePort {
  /**
   * Enqueue (durable, coalescing, idempotent — ADR-017 law 2): an identical live
   * job (same subjectKey in queued|claimed) answers its jobId with coalesced:true.
   */
  enqueue: (input: {
    readonly job: AiEnqueueInput;
    readonly enqueuedAtSeq: number;
    readonly jobId: string;
    readonly now: number;
  }) => Promise<Result<AiEnqueueOutcome, LedgeError>>;
  /**
   * Lane-gated claim with lease: picks the highest-priority queued job among the
   * admitted lanes whose retry budget is intact; stamps lease{workerTag,expires}
   * (EES §3.6: lease = 2 missed beats ⇒ reclaim). Jobs past the retry budget are
   * terminally failed here (attempts-exhausted) instead of being claimed forever.
   */
  claimNext: (input: {
    readonly lanes: readonly AiLane[];
    readonly workerTag: string;
    readonly now: number;
  }) => Promise<Result<AiClaim | null, LedgeError>>;
  /** Heartbeat ⇒ lease renewal. false = no live lease for that worker (stale beat
   *  after reclaim — benign, ignored by law). */
  heartbeat: (input: {
    readonly jobId: string;
    readonly workerTag: string;
    readonly now: number;
  }) => Promise<Result<boolean, LedgeError>>;
  /**
   * Release a claimed job back to queued (transient failure path — provider error,
   * timeout, worker lost). The attempt stands (claims are the retry accounting);
   * the NEXT claim observes the demoted ladder state from the attempts ledger.
   */
  release: (input: {
    readonly jobId: string;
    readonly workerTag: string;
    readonly now: number;
  }) => Promise<Result<boolean, LedgeError>>;
  /** Lease sweep (EES §3.6: 2 missed beats ⇒ reclaim): expired leases return to
   *  queued with the worker-lost accounting on the row (attempts already paid by
   *  the dead claim). Re-entrancy law: reclaim is idempotent — sweeping twice
   *  over the same expiry is a no-op on the second pass. */
  reclaimExpired: (input: {
    readonly now: number;
  }) => Promise<Result<{ readonly reclaimed: readonly string[] }, LedgeError>>;
  /**
   * Terminal failure write (malformed/invalid/exhausted classes). Reject+count
   * law: malformed-artifact and artifact-invalid bump the counted rejections
   * the ai-lanes probe reports. false = job not found or already terminal.
   */
  markFailed: (input: {
    readonly jobId: string;
    readonly failureClass: AiFailureClass;
    readonly now: number;
  }) => Promise<Result<boolean, LedgeError>>;
  /**
   * THE EXACTLY-ONCE HINGE (EES §2.12): the completion marker write, executed by
   * the queue inside the application's hinged journal commit. Re-reads the row
   * and THROWS on any already-terminal state (a duplicate completion aborts the
   * event AND the marker in one fate — §5 law 2) or on lease mismatch (stale
   * worker writing against a reclaimed job). Never call outside a hinged commit.
   */
  writeTerminalHinge: (
    tx: TxScope,
    input: AiTerminalWrite & { readonly now: number },
  ) => Promise<void>;
  /** Queue statistics for the §12 ai-lanes probe (lane depths + counted rejects). */
  stats: (input: { readonly now: number }) => Promise<Result<AiQueueStats, LedgeError>>;
  /** Retention sweep (EES §5 ai_jobs row law: terminal jobs purge after 7 days). */
  purgeTerminal: (input: {
    readonly now: number;
  }) => Promise<Result<{ purged: number }, LedgeError>>;
}

// ─── Worker-host seam (application ↔ infrastructure/ai host implementations) ──

/** Worker input for a 'mission-name' job (payloadRef.input vocabulary, versioned
 *  with the kind). Pure data; the producing flow owns assembly. */
export interface MissionNameInput {
  readonly tabCount: number;
  readonly rootDomains: readonly string[];
  readonly takenAt: number;
}

/** Result of one job attempt at a host (pre-validation — the §2.12 post-validation
 *  law is the queue's/application's, never the host's). */
export type ExecuteOutcome =
  | {
      readonly kind: 'artifact';
      /** Raw producer candidate; the application validates before any write. */
      readonly candidate: unknown;
      readonly providerId: string;
    }
  | { readonly kind: 'provider-error'; readonly providerId: string }
  | { readonly kind: 'no-rung' }
  | { readonly kind: 'host-unavailable' }
  | { readonly kind: 'host-lost' };

export interface AiWorkerHost {
  readonly hostId: 'sw-local' | 'workroom';
  /** Cheap readiness answer (workroom: capability says spawnable + observed Ready). */
  readonly available: (input: { readonly now: number }) => Promise<boolean>;
  /** Run one claimed job end-to-end at the host. Deadline enforcement belongs to
   *  the service (abandon law) — hosts stay timer-free. */
  readonly execute: (input: {
    readonly job: AiJobRow;
    readonly now: number;
    readonly deadlineMs: number;
  }) => Promise<ExecuteOutcome>;
  /** Best-effort cancel (§3.6 JobCancel law: terminal still authoritative). */
  readonly abandon?: ((input: { readonly jobId: string }) => void) | undefined;
}

/** The §3.6 host+inbox pair (SW side of the workroom lane). */
export interface WorkroomPair {
  readonly host: AiWorkerHost;
  /** Validated-envelope demux (false = not ours; the dispatcher keeps totality). */
  readonly inbox: (message: ValidatedMessage) => boolean;
  /** Beats ride this seam upward (the service renews leases on JobHeartbeat). */
  readonly setHeartbeatSink: (
    sink: ((input: { readonly jobId: string; readonly pct: number }) => void) | null,
  ) => void;
  /** Probe/inspect seam: readiness as last observed (Ready true, Shutdown false). */
  readonly isWorkroomReady: () => boolean;
}

/** Wire seams for the workroom pair (roots bind CONTRACT_V/cid/hash + runtime). */
export interface WorkroomWireDeps {
  readonly encode: (input: {
    readonly name: string;
    readonly payload: Record<string, unknown>;
  }) => MessageEnvelope;
  readonly send: (message: MessageEnvelope) => void;
  readonly offscreen: OffscreenPort;
}

// ─── Provider ladder seam (ADR-018 rung + breaker evidence) ──────────────────

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface ProviderBreakerReport {
  readonly providerId: string;
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
}

// ─── Probe evidence (§12 ai-lanes reads this through the diagnostics seam) ─────

export interface AiServiceStats {
  readonly queue: AiQueueStats;
  readonly breakers: readonly ProviderBreakerReport[];
  readonly workroom: {
    readonly present: boolean;
    readonly ready: boolean;
    readonly consecutiveLosses: number;
    readonly backoffUntil: number | null;
  };
}

/** Re-export so provider modules build against ONE artifact vocabulary. */
export type { MemoryArtifactCandidate };
