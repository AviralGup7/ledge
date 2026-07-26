// E3-APP · StreamAppender — the single per-device STAMPING authority of the truth
// engine's application layer. EES §2.6/§2.8 laws made structural here:
//  * SINGLE HEAD READER: one hydrated (seq, lamport) memo per device; every stamping
//    advances it. The E7 perf-harness law — interleaved head-read→append on one
//    device stream collides seqs (journal: E_JOURNAL_INTEGRITY raw=seq-gap-vs-head) —
//    is closed by the per-device mutex below: stamping and appending are one
//    serialized critical section per device.
//  * INGEST COEXISTENCE: the ingest hub (E2-T05, M1-stable) stamps on its own memo.
//    A collision with it surfaces as seq-gap-vs-head; the bounded drift-retry below
//    re-hydrates, re-stamps and re-appends — the loser converges, the journal never
//    forks (durable safety is the appender's reject, not corruption). Full
//    convergence (ingest through this same authority) is recorded as remaining work
//    in docs/adr-notes/e3-app-layer.md.
//  * ack ⇒ durable ⇒ views: after append resolves, projections.apply drives the same
//    envelopes (below-watermark skips make replays free).
//  * HINGE RIDES: caller co-writes (meta undoStack, snapshot parts) commit in the
//    same IDB txn — §5 law 2 — via appendHinged.
import type {
  ApplyReport,
  ProjectionEnginePort,
} from '@/application/ports/projection-engine.port.js';
import type { AppendAck, JournalPort } from '@/application/ports/journal.port.js';
import type { StoreName, TxScope } from '@/application/ports/storage-engine.port.js';
import type { Hlc } from '@/shared-kernel/clock/index.js';
import { advance, zeroHlc } from '@/shared-kernel/clock/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

/** Co-writes that must share the append's fate (§5 law 2 durability hinge). */
export interface CommitHinge {
  readonly extraStores: readonly StoreName[];
  readonly write: (tx: TxScope) => Promise<void>;
}

export interface CommitOutcome {
  readonly ack: AppendAck;
  /** The stamped, durable envelopes (projection drive + response shaping input). */
  readonly envelopes: readonly EventEnvelope[];
}

/** withStampLock outcome contract: `committed` lists EXACTLY the envelopes the foreign
 *  appender (intent ledger) durably wrote — the memo advances by them; a foreign
 *  failure reports [] and the head re-verifies lazily. */
export interface StampedOutcome<T> {
  readonly value: T;
  readonly committed: readonly EventEnvelope[];
}

export interface StreamAppenderDeps {
  readonly journal: JournalPort;
  readonly projections: ProjectionEnginePort;
  readonly deviceId: DeviceId;
  readonly ids: IdGenerator;
  readonly now: Now;
}

export interface StreamAppender {
  /** Stamp + append (+hinge) + projection drive, serialized per device. */
  commit(input: {
    readonly plans: readonly PlannedPlan[];
    readonly key: string;
    readonly hinge?: CommitHinge | undefined;
  }): Promise<Result<CommitOutcome, LedgeError>>;
  /**
   * Serialized stamping + FOREIGN append (the intent ledger's own appendHinged):
   * the lock spans stamping and the foreign commit so no interleaving writer can
   * sit between. fn reports durably-committed envelopes via StampedOutcome.
   */
  withStampLock<T>(
    fn: (
      stamp: (plans: readonly PlannedPlan[]) => readonly EventEnvelope[],
    ) => Promise<Result<StampedOutcome<T>, LedgeError>>,
  ): Promise<Result<StampedOutcome<T>, LedgeError>>;
  /** Drive the projection engine (exposed for ledger-flow post-apply). */
  applyProjections(envelopes: readonly EventEnvelope[]): Promise<Result<ApplyReport, LedgeError>>;
  /** Hydrated device head seq (0 before first hydration / empty stream). */
  headSeq: () => number;
}

/** Plan shape accepted from domain deciders (structurally PlannedEvent — the appender
 *  never imports the domain's declaration across the seam... the domain is an island:
 *  application MAY import it; structural alias keeps this seam dependency-light). */
export interface PlannedPlan {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Bounded re-stamp attempts on ingest-collision drift (never unbounded). */
const DRIFT_MAX_ATTEMPTS = 2;

const isDrift = (e: LedgeError): boolean =>
  e.code === 'E_JOURNAL_INTEGRITY' && e.details?.['raw'] === 'seq-gap-vs-head';

export const createStreamAppender = (deps: StreamAppenderDeps): StreamAppender => {
  /** Device head memo (seq + lamport floor). null = unhydrated. */
  let memo: { readonly seq: number; readonly lamport: number } | null = null;
  /** Promise-chained per-device mutex: every critical section enqueues here. */
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next: Promise<T> = tail.then(job, job);
    // The chain must never reject (a rejected tail would break every later enqueue).
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  /** Incremental hydration: only the stream ABOVE the memo is re-read. */
  const hydrateLocked = async (): Promise<Result<void, LedgeError>> => {
    const floor = memo?.seq ?? -1;
    const read = await deps.journal.readRange({
      deviceId: deps.deviceId,
      fromSeq: floor + 1,
    });
    if (!read.ok) return err(read.error);
    let maxLamport = memo?.lamport ?? 0;
    for (const entry of read.value.events) {
      if (entry.envelope.hlc.lamport > maxLamport) maxLamport = entry.envelope.hlc.lamport;
    }
    memo = { seq: read.value.durableThrough, lamport: maxLamport };
    return ok(undefined);
  };

  /** Stamp plans against the hydrated cursor (lock-held; never exposes mid-state). */
  const stampLocked = (plans: readonly PlannedPlan[]): readonly EventEnvelope[] => {
    let cursor: Hlc =
      memo === null ? zeroHlc(deps.deviceId) : { ...zeroHlc(deps.deviceId), ...memo };
    const wall = deps.now();
    const out: EventEnvelope[] = [];
    for (const plan of plans) {
      cursor = advance(cursor, wall);
      out.push({
        eventId: deps.ids.nextId(),
        hlc: cursor,
        type: plan.type,
        payload: plan.payload,
        producerContext: 'sw',
      });
    }
    return out;
  };

  const advanceMemo = (envelopes: readonly EventEnvelope[]): void => {
    const last = envelopes[envelopes.length - 1];
    if (last === undefined) return;
    memo = { seq: last.hlc.seq, lamport: last.hlc.lamport };
  };

  const applyProjections = async (
    envelopes: readonly EventEnvelope[],
  ): Promise<Result<ApplyReport, LedgeError>> => {
    if (envelopes.length === 0) return ok({ applied: 0, skippedBelowWatermark: 0, dirtied: [] });
    return deps.projections.apply(envelopes);
  };

  const commitAttempt = async (
    plans: readonly PlannedPlan[],
    key: string,
    stampAndAppend: (
      envelopes: readonly EventEnvelope[],
      idempotencyKey: string,
    ) => Promise<Result<AppendAck, LedgeError>>,
  ): Promise<Result<{ ack: AppendAck; envelopes: readonly EventEnvelope[] }, LedgeError>> => {
    for (let round = 0; round < DRIFT_MAX_ATTEMPTS; round += 1) {
      const hydrated = await hydrateLocked();
      if (!hydrated.ok) return err(hydrated.error);
      const envelopes = stampLocked(plans);
      const idempotencyKey = `${key}#${String(round)}`;
      const appended = await stampAndAppend(envelopes, idempotencyKey);
      if (appended.ok) {
        advanceMemo(envelopes);
        return ok({ ack: appended.value, envelopes });
      }
      if (!isDrift(appended.error)) return err(appended.error);
      // Ingest interleave: the memo is provably stale — force re-hydrate, re-stamp.
      memo = null;
    }
    return err(
      ledgeError('E_CAPABILITY', {
        operation: 'stream-commit',
        fault: 'head-drift-exhausted',
      }),
    );
  };

  const appender: StreamAppender = {
    commit: (input) =>
      enqueue(async (): Promise<Result<CommitOutcome, LedgeError>> => {
        if (input.plans.length === 0) {
          // Empty truth-write: no journal bytes; still one deterministic outcome.
          return ok({
            ack: { deviceId: deps.deviceId, fromSeq: 0, toSeq: 0, count: 0 },
            envelopes: [],
          });
        }
        const attempted = await commitAttempt(input.plans, input.key, (envelopes, k) =>
          input.hinge === undefined
            ? deps.journal.append(envelopes, { idempotencyKey: k })
            : deps.journal.appendHinged(envelopes, {
                idempotencyKey: k,
                extraStores: input.hinge.extraStores,
                hinge: input.hinge.write,
              }),
        );
        if (!attempted.ok) return err(attempted.error);
        // ack ⇒ durable ⇒ views. A projection drive failure is honest: journal truth
        // is durable, views lag (rebuild is the recovery path) — never fake success.
        const applied = await applyProjections(attempted.value.envelopes);
        if (!applied.ok) return err(applied.error);
        return ok(attempted.value);
      }),

    withStampLock: <T>(
      fn: (
        stamp: (plans: readonly PlannedPlan[]) => readonly EventEnvelope[],
      ) => Promise<Result<StampedOutcome<T>, LedgeError>>,
    ): Promise<Result<StampedOutcome<T>, LedgeError>> =>
      enqueue(async (): Promise<Result<StampedOutcome<T>, LedgeError>> => {
        for (let round = 0; round < DRIFT_MAX_ATTEMPTS; round += 1) {
          const hydrated = await hydrateLocked();
          if (!hydrated.ok) return err(hydrated.error);
          const outcome = await fn(stampLocked);
          if (outcome.ok) {
            advanceMemo(outcome.value.committed);
            return outcome;
          }
          if (!isDrift(outcome.error)) return outcome;
          memo = null;
        }
        return err(
          ledgeError('E_CAPABILITY', {
            operation: 'stream-stamp-lock',
            fault: 'head-drift-exhausted',
          }),
        );
      }),

    applyProjections,

    headSeq: () => memo?.seq ?? 0,
  };
  return appender;
};
