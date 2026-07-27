// E8-T01 · application — the AI jobs service: the ONLY writer of AI artifacts
// (Blueprint §2.10 ownership law: "results exit exclusively as Memory artifacts
// via application callback" — the AI package owns the queue, THIS owns the
// hinged commit that joins the MemoryArtifactWritten event and the completion
// marker in one fate). INVISIBILITY LAW (Principle 29 / Spec §6.0): nothing here
// surfaces; jobs are durable evidence, artifacts are stamps, failures are rows —
// never banners.
//
// Exactly-once protocol (EES §2.12 "lease+completion marker under job key"):
//  claim(lease) → host executes → post-validate (§2.12, domain/memory) →
//  appender.commit hinged {MemoryArtifactWritten + queue.writeTerminalHinge}.
//  * kill mid-job ⇒ 2 missed beats ⇒ reclaim ⇒ retry ×2 ⇒ lane-fallback
//    (heuristic-forced final claim, §9 row 6) — termination is guaranteed.
//  * duplicate completion (redelivery/race) ⇒ the hinge's re-read throws ⇒ the
//    whole commit aborts in one fate ⇒ the artifact is written EXACTLY ONCE.
//  * idempotency key ai-artifact:<jobId> replays harmlessly on SW-crash resend.
import { validateArtifactCandidate, type MemoryArtifactCandidate } from '@/domain/memory/index.js';
import type {
  AiEnqueueOutcome,
  AiFailureClass,
  AiJobRow,
  AiLane,
} from '@/application/ports/ai-jobs.port.js';
import type { ValidatedMessage } from '@/application/contracts/validate.js';
import type {
  AiEnqueueInput,
  AiServiceStats,
  AiWorkerHost,
  ExecuteOutcome,
  MissionNameInput,
  MissionSummaryInput,
} from '@/application/ports/ai-jobs.port.js';
import { err, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { AiJobsServiceDeps, ServiceEdge, UseCtx } from './shared/app-ctx.js';

export type { AiServiceStats, MissionNameInput, MissionSummaryInput };
export type { AiJobScheduler, AiLaneWindowPort } from './shared/app-ctx.js';

/** Time-boxed execution budgets per lane (MV3 citizen law §10). Interactive's
 *  ceiling is the EES §7.1 2.5s rename-p95 budget itself. */
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const INTERACTIVE_RENAME_BUDGET_MS = 2_500;
const MAINTENANCE_WINDOW_SECONDS = 30;
const BACKGROUND_WINDOW_MINUTES = 2;
export const AI_LANE_DEADLINE_MS: Readonly<Record<AiLane, number>> = {
  interactive: INTERACTIVE_RENAME_BUDGET_MS,
  maintenance: MAINTENANCE_WINDOW_SECONDS * MS_PER_SECOND,
  background: BACKGROUND_WINDOW_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
};

/** Workroom loss backoff (§9 row 6 doctrine): consecutive host-level casualties
 *  (mid-flight loss, not provider failure) demote the workroom until Ready
 *  re-proves it. */
const WORKROOM_LOSS_BACKOFF_SECONDS = 30;
const WORKROOM_LOSS_BACKOFF_MS = WORKROOM_LOSS_BACKOFF_SECONDS * MS_PER_SECOND;

export interface AiEnqueueMissionNameInput {
  readonly subjectId: string;
  readonly lane: AiLane;
  readonly input: MissionNameInput;
}

/** E8-T04 (Spec §6.3 · Blueprint §6.15): park-time summarize job enqueue. Same
 *  coalescing/pump law as naming — jobs version their input vocab by kind. */
export interface AiEnqueueMissionSummaryInput {
  readonly subjectId: string;
  readonly lane: AiLane;
  readonly input: MissionSummaryInput;
}

export type AiPumpDisposition =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'completed';
      readonly jobId: string;
      readonly artifactId: string;
      readonly hostId: string;
    }
  | { readonly kind: 'duplicate-abort'; readonly jobId: string }
  | {
      readonly kind: 'failed';
      readonly jobId: string;
      readonly failureClass: AiFailureClass;
      readonly hostId: string;
    }
  | {
      readonly kind: 'released';
      readonly jobId: string;
      readonly hostId: string;
      readonly why: string;
    };

export interface AiJobsService {
  /** Application entry: durable coalescing enqueue (flows E8-T05+ ride this;
   *  the pipeline itself is the E8-T01 deliverable). Kicks the pump. */
  readonly enqueueMissionName: (
    input: AiEnqueueMissionNameInput,
    ctx: UseCtx,
  ) => Promise<Result<AiEnqueueOutcome, LedgeError>>;
  /** E8-T04 park-time summaries ride the identical enqueue law (kind-keyed
   *  coalescing keeps a queued name job and a queued summary apart). */
  readonly enqueueMissionSummary: (
    input: AiEnqueueMissionSummaryInput,
    ctx: UseCtx,
  ) => Promise<Result<AiEnqueueOutcome, LedgeError>>;
  /** One drain step: reclaim sweep → lane admission → claim → execute → classify. */
  readonly pump: (ctx: UseCtx) => Promise<Result<AiPumpDisposition, LedgeError>>;
  /** ai-lanes probe evidence (queue depths + breakers + workroom posture). */
  readonly stats: () => Promise<Result<AiServiceStats, LedgeError>>;
  /** §3.6 inbound family demux (roots graft before the command dispatcher). */
  readonly inbox: (message: ValidatedMessage) => boolean;
}

/** Service-side jobId → lease tag ledger for heartbeat renewals (§3.6 beat law:
 *  a beat renews the LEASE of the current claim owner; unknown/terminal jobs are
 *  stale beats — ignored by law). */
export const createAiJobsService = (edge: ServiceEdge, own: AiJobsServiceDeps): AiJobsService => {
  const { deps, appender } = edge;
  const { queue, swLocal, workroom, breakers, window, scheduler } = own;
  const inflight = new Map<string, string>();
  let workroomLosses = 0;
  let workroomBackoffUntil: number | null = null;
  let pumping = false;
  let kickPending = false;

  const workerTagFor = (): string => `sw-${deps.ids.nextId()}`;

  const admittedLanes = async (): Promise<readonly AiLane[]> => {
    const lanes: AiLane[] = ['interactive'];
    if (await window.maintenanceOk()) lanes.push('maintenance');
    if (await window.backgroundOk()) lanes.push('background');
    return lanes;
  };

  const noteWorkroomLoss = (now: number): void => {
    workroomLosses += 1;
    workroomBackoffUntil = now + WORKROOM_LOSS_BACKOFF_MS;
  };

  const noteWorkroomProven = (): void => {
    workroomLosses = 0;
    workroomBackoffUntil = null;
  };

  const hostOrder = async (now: number): Promise<readonly AiWorkerHost[]> => {
    if (workroom === null) return [swLocal];
    if (workroomBackoffUntil !== null && now < workroomBackoffUntil) return [swLocal];
    if (!(await workroom.host.available({ now }))) return [swLocal];
    return [workroom.host, swLocal];
  };

  /** Deadline race: the attempt's promise stays (a late resolution is dropped);
   *  the abandon law sends JobCancel best-effort (§3.6 terminal authority). */
  const executeWithDeadline = (
    host: AiWorkerHost,
    job: AiJobRow,
    now: number,
  ): Promise<{ outcome: ExecuteOutcome; timedOut: boolean }> =>
    new Promise((resolve) => {
      let settled = false;
      const cancelTimer = scheduler.after(AI_LANE_DEADLINE_MS[job.lane], () => {
        if (settled) return;
        settled = true;
        host.abandon?.({ jobId: job.jobId });
        resolve({ outcome: { kind: 'host-lost' }, timedOut: true });
      });
      void host
        .execute({ job, now, deadlineMs: AI_LANE_DEADLINE_MS[job.lane] })
        .then((outcome) => {
          if (settled) return;
          settled = true;
          cancelTimer();
          resolve({ outcome, timedOut: false });
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          cancelTimer();
          resolve({
            outcome: { kind: 'provider-error', providerId: host.hostId },
            timedOut: false,
          });
        });
    });

  const commitArtifact = async (
    job: AiJobRow,
    candidate: MemoryArtifactCandidate,
    now: number,
  ): Promise<
    | { readonly kind: 'completed'; readonly artifactId: string }
    | { readonly kind: 'duplicate-abort' }
    | { readonly kind: 'commit-error'; readonly error: LedgeError }
  > => {
    const artifactId = deps.ids.nextId();
    const committed = await appender.commit({
      plans: [
        {
          type: 'MemoryArtifactWritten',
          payload: {
            artifactId,
            subjectId: job.payloadRef.subjectId,
            kind: job.kind,
            value: candidate.value,
            confidence: candidate.confidence,
            provider: candidate.provider,
            modelClass: candidate.modelClass,
            schemaV: candidate.schemaV,
            // E8-T04 additive: the §6.3 thread narrative rides the same artifact
            // when the provider produced one (exactOptionalPropertyTypes law).
            ...(candidate.thread !== undefined ? { thread: candidate.thread } : {}),
            derivedFromSeqRange: { from: job.enqueuedAtSeq, to: appender.headSeq() },
          },
        },
      ],
      key: `ai-artifact:${job.jobId}`,
      hinge: {
        extraStores: ['ai_jobs'],
        write: (tx) =>
          queue.writeTerminalHinge(tx, {
            jobId: job.jobId,
            artifactId,
            workerTag: inflight.get(job.jobId) ?? '',
            now,
          }),
      },
    });
    if (committed.ok) return { kind: 'completed', artifactId };
    const reason = committed.error.details?.['reason'];
    // Exactly-once law observed: the hinge's re-read rejected a duplicate or
    // stale completion — the marker already stands, nothing to repair.
    if (
      committed.error.code === 'E_DOMAIN_LEGALITY' &&
      typeof reason === 'string' &&
      (reason.startsWith('job-not-claimed') ||
        reason === 'lease-mismatch' ||
        reason === 'job-missing')
    ) {
      return { kind: 'duplicate-abort' };
    }
    return { kind: 'commit-error', error: committed.error };
  };

  const classify = async (
    job: AiJobRow,
    hostId: string,
    executed: { outcome: ExecuteOutcome; timedOut: boolean },
    now: number,
  ): Promise<AiPumpDisposition> => {
    const { outcome, timedOut } = executed;
    const workerTag = inflight.get(job.jobId) ?? '';
    if (timedOut) {
      // Timeout = worker presumed lost (§9 row 6): the claim was consumed, the
      // job released for the retry ladder; workroom casualty backoff noted.
      if (hostId === 'workroom') noteWorkroomLoss(now);
      await queue.release({ jobId: job.jobId, workerTag, now });
      return { kind: 'released', jobId: job.jobId, hostId, why: 'timeout' };
    }
    switch (outcome.kind) {
      case 'artifact': {
        if (hostId === 'workroom') noteWorkroomProven();
        const validation = validateArtifactCandidate(outcome.candidate);
        if (validation.kind === 'rejected') {
          // Reject + count (§2.12 malformed law — never ship, never silent).
          const failureClass: AiFailureClass =
            validation.rejectClass === 'malformed-shape'
              ? 'malformed-artifact'
              : 'artifact-invalid';
          await queue.markFailed({ jobId: job.jobId, failureClass, now });
          return { kind: 'failed', jobId: job.jobId, failureClass, hostId };
        }
        const committed = await commitArtifact(job, validation.artifact, now);
        if (committed.kind === 'completed')
          return { kind: 'completed', jobId: job.jobId, artifactId: committed.artifactId, hostId };
        if (committed.kind === 'duplicate-abort')
          return { kind: 'duplicate-abort', jobId: job.jobId };
        // Commit-fault classes: a contract-invalid event envelope is OUR
        // transduction defect — terminal + counted, never retried (deterministic);
        // anything else is a storage-class fault ⇒ release for the retry ladder.
        if (committed.error.code === 'E_OUTPUT_MALFORMED') {
          await queue.markFailed({ jobId: job.jobId, failureClass: 'malformed-artifact', now });
          return { kind: 'failed', jobId: job.jobId, failureClass: 'malformed-artifact', hostId };
        }
        await queue.release({ jobId: job.jobId, workerTag, now });
        return {
          kind: 'released',
          jobId: job.jobId,
          hostId,
          why: `commit-error:${committed.error.code}`,
        };
      }
      case 'no-rung':
        // No eligible rung incl. heuristic — terminal by exhaustion law, counted.
        await queue.markFailed({ jobId: job.jobId, failureClass: 'provider-error', now });
        return { kind: 'failed', jobId: job.jobId, failureClass: 'provider-error', hostId };
      case 'provider-error':
        await queue.release({ jobId: job.jobId, workerTag, now });
        return { kind: 'released', jobId: job.jobId, hostId, why: 'provider-error' };
      case 'host-unavailable':
      case 'host-lost':
        await queue.release({ jobId: job.jobId, workerTag, now });
        return { kind: 'released', jobId: job.jobId, hostId, why: 'all-hosts-unavailable' };
    }
  };

  const pumpOnce = async (ctx: UseCtx): Promise<Result<AiPumpDisposition, LedgeError>> => {
    ctx.token.throwIfCancelled();
    const now = deps.now();
    const swept = await queue.reclaimExpired({ now });
    if (!swept.ok) return err(swept.error);
    const lanes = await admittedLanes();
    const tag = workerTagFor();
    const claimed = await queue.claimNext({ lanes, workerTag: tag, now });
    if (!claimed.ok) return err(claimed.error);
    const job = claimed.value;
    if (job === null) return ok({ kind: 'idle' });
    inflight.set(job.jobId, tag);

    try {
      const hosts = await hostOrder(now);
      // Host fallthrough within ONE claim: pre-execution unavailability and
      // mid-flight loss pass to the next host (§9 row 6 collapse in miniature);
      // consumed attempts (timeout/provider classes) classify terminally.
      let executed: { outcome: ExecuteOutcome; timedOut: boolean } | null = null;
      let hostId = hosts[0]?.hostId ?? 'sw-local';
      let index = 0;
      while (index < hosts.length) {
        const host = hosts[index];
        if (host === undefined) break;
        hostId = host.hostId;
        executed = await executeWithDeadline(host, job, now);
        if (
          !executed.timedOut &&
          (executed.outcome.kind === 'host-unavailable' || executed.outcome.kind === 'host-lost')
        ) {
          if (host.hostId === 'workroom' && executed.outcome.kind === 'host-lost') {
            noteWorkroomLoss(now);
          }
          index += 1;
          continue;
        }
        break;
      }
      return ok(
        await classify(
          job,
          hostId,
          executed ?? { outcome: { kind: 'host-unavailable' }, timedOut: false },
          now,
        ),
      );
    } finally {
      inflight.delete(job.jobId);
    }
  };

  /** Shared enqueue law (kind is the only degree of freedom — same coalescing
   *  key space, same pump kick, same durability hinge). */
  const enqueueJob = async (
    enqueue: AiEnqueueInput,
    ctx: UseCtx,
  ): Promise<Result<AiEnqueueOutcome, LedgeError>> => {
    ctx.token.throwIfCancelled();
    const enqueued = await queue.enqueue({
      job: enqueue,
      enqueuedAtSeq: appender.headSeq(),
      jobId: deps.ids.nextId(),
      now: deps.now(),
    });
    if (!enqueued.ok) return err(enqueued.error);
    if (!enqueued.value.coalesced) {
      // Pump kick (single-flight coalesced): drains run one claim per round.
      scheduler.after(0, () => {
        void service.pump(ctx).catch(() => undefined);
      });
    }
    return ok(enqueued.value);
  };

  const service: AiJobsService = {
    enqueueMissionName: (input, ctx) =>
      enqueueJob(
        {
          kind: 'mission-name',
          subjectId: input.subjectId,
          lane: input.lane,
          input: input.input,
        },
        ctx,
      ),
    enqueueMissionSummary: (input, ctx) =>
      enqueueJob(
        {
          kind: 'mission-summary',
          subjectId: input.subjectId,
          lane: input.lane,
          input: input.input,
        },
        ctx,
      ),

    pump: async (ctx) => {
      if (pumping) {
        // Single-flight law: concurrent pumps coalesce into one queued kick.
        kickPending = true;
        return ok({ kind: 'idle' });
      }
      pumping = true;
      try {
        const report = await pumpOnce(ctx);
        if (kickPending) {
          kickPending = false;
          scheduler.after(0, () => {
            void service.pump(ctx).catch(() => undefined);
          });
        }
        return report;
      } finally {
        pumping = false;
      }
    },

    stats: async () => {
      const queueStats = await queue.stats({ now: deps.now() });
      if (!queueStats.ok) return err(queueStats.error);
      return ok({
        queue: queueStats.value,
        breakers: breakers(),
        workroom: {
          present: workroom !== null,
          ready: workroom?.isWorkroomReady() ?? false,
          consecutiveLosses: workroomLosses,
          backoffUntil: workroomBackoffUntil,
        },
      });
    },

    inbox: (message) => workroom?.inbox(message) ?? false,
  };

  // §3.6 beat law: heartbeats renew the current claim owner's lease.
  workroom?.setHeartbeatSink(({ jobId }) => {
    const tag = inflight.get(jobId);
    if (tag === undefined) return;
    void queue.heartbeat({ jobId, workerTag: tag, now: deps.now() }).catch(() => undefined);
  });

  return service;
};
