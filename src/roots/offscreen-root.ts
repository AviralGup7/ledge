// Workroom (offscreen document) composition root (ADR-008/025 · E1-T12). The workroom
// hosts the heavy lanes (AI jobs, import/export parsing) as they wire in E3+; its real
// E1 composition is the §3.6 liveness protocol over the message contract: the SW's
// EnsureWorkroom probe is answered with WorkroomReady. Validators run before dispatch
// (§3.1 rule a); unknown names are ignored, never thrown (rule b).
import {
  CONTRACT_V,
  computeContractHash,
  makeHello,
  validateMessage,
} from '@/application/contracts/index.js';
import type { Hello, MessageEnvelope, ValidationOutcome } from '@/application/contracts/index.js';
import { platformIds, type IdGenerator } from '@/shared-kernel/identity/index.js';
import type { AiPayloadRef } from '@/application/ports/ai-jobs.port.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import { createAiLadder, createHeuristicNamer } from '@/infrastructure/ai/index.js';
import { createOnDeviceNamer } from '@/infrastructure/ai/providers/ondevice/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const WORKROOM_CONTEXT = 'offscreen' as const;

// ─── E8-T01 · §3.6 job executor seam ─────────────────────────────────────────
// The workroom EXECUTES offered jobs under its own ladder composition (the
// rung-1 heuristic is stateless, so SW and workroom share the rung without
// shared state). Post-validation (§2.12) is the SW side's law — the workroom
// returns the raw candidate; the offer's deadline is the SW's watch.

export interface WorkroomJobOutcome {
  readonly artifact?: MemoryArtifactCandidate | undefined;
  readonly failureClass?: string | undefined;
}

export interface WorkroomJobExecutor {
  readonly execute: (job: {
    readonly jobId: string;
    readonly kind: string;
    readonly payloadRef: AiPayloadRef;
    readonly lane: string;
    readonly deadlineMs: number;
  }) => Promise<WorkroomJobOutcome>;
}

/** Default workroom ladder (E8-T03): on-device rung registers when the model
 *  verifies, heuristic stands last. Yields fall to the next rung; failure
 *  classes ride the wire for SW classification. */
const createWorkroomExecutor = async (): Promise<WorkroomJobExecutor> => {
  const ondevice = await createOnDeviceNamer();
  const providers = [...(ondevice !== null ? [ondevice] : []), createHeuristicNamer()];
  const ladder = createAiLadder({ providers });
  return {
    execute: async (job) => {
      const rungs = ladder.resolve({
        kind: job.kind as never,
        now: Date.now(),
        forceHeuristic: false,
      });
      for (const rung of rungs) {
        const ran: Result<MemoryArtifactCandidate, LedgeError> = await rung.run({
          kind: job.kind as never,
          subjectId: job.payloadRef.subjectId,
          value: job.payloadRef.input,
        });
        if (ran.ok) return { artifact: ran.value };
      }
      return { failureClass: 'provider-error' };
    },
  };
};

/** Sync composition with async capability detection: the executor resolves the
 *  verified ladder lazily and single-flight (graph composition stays sync per
 *  E1 root law; the ~1ms model verify rides the first offer). */
const createDefaultWorkroomExecutor = (): WorkroomJobExecutor => {
  let pending: Promise<WorkroomJobExecutor> | null = null;
  const ready = (): Promise<WorkroomJobExecutor> => {
    pending ??= createWorkroomExecutor();
    return pending;
  };
  return {
    execute: (job) => ready().then((executor) => executor.execute(job)),
  };
};

export interface WorkroomTransport {
  /** Push one validated envelope toward the SW (runtime channel in prod, stub in tests). */
  readonly send: (message: MessageEnvelope) => void;
}

export interface WorkroomGraphDeps {
  /** Outbound channel seam; production binds chrome.runtime.sendMessage. */
  readonly transport?: WorkroomTransport;
  /** cid generator seam for replies; production binds the platform generator. */
  readonly ids?: IdGenerator;
  /** Test seam: fixed contract hash (production computes from the live registry). */
  readonly contractHash?: string;
  /** E8-T01 job executor seam (default: the heuristic ladder). Tests inject the
   *  kill/determinism point for the §3.6 protocol proofs. */
  readonly executor?: WorkroomJobExecutor;
  /** Timestamp seam for job lifecycle stamps; production binds Date.now. */
  readonly now?: () => number;
}

export interface WorkroomGraph {
  readonly context: typeof WORKROOM_CONTEXT;
  /** Handshake material for the hub channel (§3.1 hash agreement, ADR-010). */
  readonly hello: Hello;
  /**
   * Inbound dispatch — total over hostile input: any value yields a ValidationOutcome
   * (observable by the diagnostics lane once it lands; §3.1 rule b's ignore+log).
   */
  readonly dispatch: (raw: unknown) => ValidationOutcome;
}

const workroomReady = (cid: IdGenerator, contractHash: string): MessageEnvelope => ({
  v: CONTRACT_V,
  kind: 'event',
  name: 'WorkroomReady',
  cid: cid.nextId(),
  senderContext: WORKROOM_CONTEXT,
  // Executor lanes resolve real capabilities in E3+; an empty object claims none.
  payload: { capabilitiesResolved: {} },
  contractHash,
});

export function composeWorkroomGraph(deps: WorkroomGraphDeps = {}): WorkroomGraph {
  const transport = deps.transport ?? { send: () => undefined };
  const ids = deps.ids ?? platformIds;
  const contractHash = deps.contractHash ?? computeContractHash();
  const executor = deps.executor ?? createDefaultWorkroomExecutor();

  const emit = (name: string, payload: Record<string, unknown>): void => {
    transport.send({
      v: CONTRACT_V,
      kind: 'event',
      name,
      cid: ids.nextId(),
      senderContext: WORKROOM_CONTEXT,
      payload,
      contractHash,
    });
  };

  return {
    context: WORKROOM_CONTEXT,
    hello: makeHello(WORKROOM_CONTEXT, contractHash),
    dispatch: (raw: unknown): ValidationOutcome => {
      const outcome = validateMessage(raw, { zone: 'zone0' });
      if (outcome.type !== 'ok' || outcome.message.senderContext !== 'sw') return outcome;
      if (outcome.message.name === 'EnsureWorkroom') {
        transport.send(workroomReady(ids, contractHash));
        return outcome;
      }
      // E8-T01 · §3.6 job lane: offer ⇒ claim ⇒ start-beat ⇒ execute ⇒ terminal
      // JobResult. JobCancel is best-effort (SW-side authority is the terminal
      // marker; a cancel racing in-flight execution simply lets the result die
      // unanswered — the SW's abandoned waiter is already gone).
      if (outcome.message.name === 'JobOffer') {
        const p = outcome.message.payload;
        const jobId = typeof p['jobId'] === 'string' ? p['jobId'] : null;
        const kind = typeof p['kind'] === 'string' ? p['kind'] : null;
        if (jobId === null || kind === null) return outcome;
        emit('JobClaimed', { jobId, workerTag: WORKROOM_CONTEXT });
        emit('JobHeartbeat', { jobId, pct: 0 });
        void executor
          .execute({
            jobId,
            kind,
            payloadRef: (p['payloadRef'] ?? {
              subjectId: '',
              input: undefined,
              stateHash: '',
            }) as AiPayloadRef,
            lane: typeof p['lane'] === 'string' ? p['lane'] : 'maintenance',
            deadlineMs: typeof p['deadlineMs'] === 'number' ? p['deadlineMs'] : 0,
          })
          .then((done) => {
            emit('JobHeartbeat', { jobId, pct: 1 });
            emit(
              'JobResult',
              done.artifact !== undefined
                ? { jobId, ok: true, artifact: { ...done.artifact } }
                : { jobId, ok: false, failureClass: done.failureClass ?? 'provider-error' },
            );
          })
          .catch(() => {
            emit('JobResult', { jobId, ok: false, failureClass: 'provider-error' });
          });
      }
      return outcome;
    },
  };
}

/**
 * Activate the workroom context. The listener registers synchronously (ADR-007) and
 * performs no async hold (it returns void, so MV3 never keeps the channel suspended).
 */
export function bootstrapWorkroom(): WorkroomGraph {
  const graph = composeWorkroomGraph({
    transport: {
      send: (message) => {
        void chrome.runtime.sendMessage(message);
      },
    },
  });
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    graph.dispatch(raw);
  });
  return graph;
}
