// E8-T01 · infrastructure/ai — worker hosts: WHERE a claimed job runs. Two hosts,
// one contract (Blueprint §9 row 6 collapse law):
//  * SW-LOCAL — the ladder executed in the service worker. Always available; the
//    heuristic tier is instantaneous, so the interactive lane NEVER waits on the
//    offscreen document (the EES §7.1 2.5s budget is unreachable by design).
//  * WORKROOM — the §3.6 protocol client: EnsureWorkroom → WorkroomReady →
//    JobOffer → JobClaimed → JobHeartbeat* → JobResult, with JobCancel as the
//    best-effort abandon law (terminal results stay authoritative, §3.6). This
//    module speaks message VALUES through its injected encode/send seams — it
//    never touches chrome.runtime itself (A-02 containment stays complete).
import type {
  AiWorkerHost,
  ExecuteOutcome,
  WorkroomPair,
  WorkroomWireDeps,
} from '@/application/ports/ai-jobs.port.js';
import type { AiLadder } from './ladder.js';

export type { AiWorkerHost, ExecuteOutcome, WorkroomPair, WorkroomWireDeps };

/** SW-local host: ladder in-process. The heartbeat lease law is moot in-process —
 *  the claim's lease comfortably outlives synchronous heuristic compute. */
export function createSwLocalWorkerHost(deps: { readonly ladder: AiLadder }): AiWorkerHost {
  return {
    hostId: 'sw-local',
    available: () => Promise.resolve(true),
    execute: async ({ job, now }) => {
      const rungs = deps.ladder.resolve({
        kind: job.kind,
        now,
        forceHeuristic: job.forceHeuristic === true,
      });
      if (rungs.length === 0) return { kind: 'no-rung' };
      let lastProviderId = rungs[rungs.length - 1]?.providerId ?? 'unknown';
      for (const rung of rungs) {
        lastProviderId = rung.providerId;
        const ran = await rung.run({
          kind: job.kind,
          subjectId: job.payloadRef.subjectId,
          value: job.payloadRef.input,
        });
        if (ran.ok) {
          deps.ladder.noteSuccess(rung.providerId);
          return { kind: 'artifact', candidate: ran.value, providerId: rung.providerId };
        }
        // Provider error ⇒ circuit-break accounting + next ladder rung (§2.12).
        // YIELD law (E8-T03): a typed no-confidence yield is NOT a strike — thin
        // evidence is an absence, not a fault; the next rung runs unconditionally.
        if (ran.error.details?.['yield'] !== true) {
          deps.ladder.noteFailure({ providerId: rung.providerId, now });
        }
      }
      return { kind: 'provider-error', providerId: lastProviderId };
    },
  };
}

/** §3.6 inbound family — validated envelopes of these names route to the pair's
 *  inbox BEFORE the command dispatcher (internal traffic, never a command). */
export const WORKROOM_EVENT_NAMES = [
  'WorkroomReady',
  'JobClaimed',
  'JobHeartbeat',
  'JobResult',
  'WorkroomShutdown',
] as const;

/**
 * The §3.6 host+inbox pair (shared liveness state). Readiness = document ensured
 * + WorkroomReady observed. Kill evidence = silence: the service-side deadline
 * abandons the attempt, the lease expires (2 missed beats), the queue reclaims —
 * Blueprint §9 row 6's exact ladder. Spawn failure never hangs: ensureDocument's
 * err resolves pending waiters host-unavailable.
 */
export function createWorkroomHostPair(deps: WorkroomWireDeps): WorkroomPair {
  let ready = false;
  /** Readiness waiters resolve a bare boolean — the §3.6 handshake is a liveness
   *  fact, never a job outcome. */
  const readyWaiters = new Set<(becameReady: boolean) => void>();
  const jobWaiters = new Map<string, (outcome: ExecuteOutcome) => void>();
  let heartbeatSink: ((input: { readonly jobId: string; readonly pct: number }) => void) | null =
    null;

  const emit = (name: string, payload: Record<string, unknown>): void => {
    deps.send(deps.encode({ name, payload }));
  };

  const resolveReadyWaiters = (becameReady: boolean): void => {
    for (const waiter of readyWaiters) waiter(becameReady);
    readyWaiters.clear();
  };

  /** Shutdown law: readiness waiters hear false; in-flight jobs hear 'host-lost'
   *  (mid-flight death — the offer WAS accepted, the work is gone). The split
   *  matters to the service's claim accounting. */
  const resolveShutdown = (): void => {
    resolveReadyWaiters(false);
    for (const waiter of jobWaiters.values()) waiter({ kind: 'host-lost' });
    jobWaiters.clear();
  };

  const host: AiWorkerHost = {
    hostId: 'workroom',

    available: async () => {
      const cap = deps.offscreen.capability();
      return cap.ok && cap.value.apiPresent;
    },

    execute: async ({ job, deadlineMs }) => {
      const ensured = await deps.offscreen.ensureDocument({ spawnClass: 'ai-jobs' });
      if (!ensured.ok) return { kind: 'host-unavailable' };
      if (!ready) {
        emit('EnsureWorkroom', { reasonHint: 'ai-jobs' });
        const becameReady = await new Promise<boolean>((resolve) => {
          readyWaiters.add(resolve);
        });
        if (!becameReady) return { kind: 'host-unavailable' };
      }
      emit('JobOffer', {
        jobId: job.jobId,
        kind: job.kind,
        payloadRef: job.payloadRef,
        lane: job.lane,
        deadlineMs,
      });
      return new Promise<ExecuteOutcome>((resolve) => {
        jobWaiters.set(job.jobId, resolve);
      });
    },

    abandon: ({ jobId }) => {
      if (!jobWaiters.delete(jobId)) return;
      emit('JobCancel', { jobId });
    },
  };

  return {
    host,
    setHeartbeatSink: (sink) => {
      heartbeatSink = sink;
    },
    isWorkroomReady: () => ready,
    inbox: (message) => {
      switch (message.name) {
        case 'WorkroomReady':
          ready = true;
          resolveReadyWaiters(true);
          return true;
        case 'JobClaimed':
          // Claim confirmation is evidential (no waiter registration needed —
          // the offer-side waiter already stands). Heartbeats renew leases.
          return true;
        case 'JobHeartbeat': {
          const jobId =
            typeof message.payload['jobId'] === 'string' ? message.payload['jobId'] : null;
          const pct = typeof message.payload['pct'] === 'number' ? message.payload['pct'] : null;
          if (jobId !== null && pct !== null) heartbeatSink?.({ jobId, pct });
          return true;
        }
        case 'JobResult': {
          const jobId =
            typeof message.payload['jobId'] === 'string' ? message.payload['jobId'] : null;
          if (jobId === null) return true;
          const waiter = jobWaiters.get(jobId);
          if (waiter === undefined) return true; // abandoned/stale — tolerated by law
          jobWaiters.delete(jobId);
          waiter(
            message.payload['ok'] === true
              ? { kind: 'artifact', candidate: message.payload['artifact'], providerId: 'workroom' }
              : {
                  kind: 'provider-error',
                  providerId:
                    typeof message.payload['failureClass'] === 'string'
                      ? message.payload['failureClass']
                      : 'workroom',
                },
          );
          return true;
        }
        case 'WorkroomShutdown':
          ready = false;
          resolveShutdown();
          return true;
        default:
          return false;
      }
    },
  };
}
