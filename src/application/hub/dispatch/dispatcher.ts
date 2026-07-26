// E3-APP · Dispatcher — the single mutation entry (EES §2.6). Envelope → contract
// validation (§3.1) → dedupe (§3.3 timeouts) → lane admission → observable execution
// (timing + structured log + progress + cancellation) → exactly ONE terminal per
// accepted command, published on the application event bus — pending is never terminal
// (§2.6 post law; two-phase commands additionally emit CommandAck per §3.5 through
// ctx.notifyPending). The transport surface (chrome runtime wiring, E3-T* tier)
// renders these into runtime messages; SW-internal callers use terminalOf().
import { err, ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import {
  validateInternalMessage,
  validateMessage,
  type InternalRoster,
  type ValidatedMessage,
} from '../../contracts/validate.js';
import type { MessageZone } from '../../contracts/envelope.js';
import { operationLabel, toApplicationError } from '../../errors/index.js';
import { createAppEventBus, type AppEventBus } from './app-events.js';
import {
  createCancellationRegistry,
  cancelledTerminalError,
  isCancelledMarker,
  type CancellationRegistry,
} from './cancellation.js';
import { createCidDedupeCache, type CidDedupeCache } from './cid-dedupe.js';
import { emitterFor } from './progress.js';
import type { StructuredLogSink } from './log.js';
import type { HandlerRegistry } from './registry.js';
import type { DispatchAnswer, Handler, HandlerCtx, Lane, TerminalRecord } from './types.js';

/** Lane admission ceilings (named per §2; lane pressure ≈ coincidence, not policy). */
const INTERACTIVE_INFLIGHT_CAP = 16;
const MAINTENANCE_INFLIGHT_CAP = 1;
const MAINTENANCE_QUEUE_CAP = 8;

export interface DispatcherDeps<S> {
  readonly registry: HandlerRegistry<S>;
  readonly services: S;
  readonly logSink: StructuredLogSink;
  readonly events?: AppEventBus | undefined;
  readonly cancellation?: CancellationRegistry | undefined;
  readonly dedupe?: CidDedupeCache | undefined;
  readonly now?: () => number;
  /**
   * Tier-2 internal surface (E3-APP): when set, dispatch validates against this
   * roster — envelope-shape laws only, payload un-normalized (the handler is the
   * typed seam) — and serves ONLY those names. Wire-registry names are not routed
   * here (the composition root routes by name; parity law keeps the sets disjoint).
   */
  readonly internal?: InternalRoster | undefined;
}

export interface Dispatcher {
  readonly dispatch: (raw: unknown, zone: MessageZone) => DispatchAnswer;
  /** In-process terminal awaiter (tests, roots). Never the surface transport. */
  readonly terminalOf: (cid: string) => Promise<TerminalRecord>;
  readonly cancel: (cid: string) => boolean;
  readonly inflight: () => { readonly interactive: number; readonly maintenance: number };
  readonly events: AppEventBus;
}

export const createDispatcher = <S>(deps: DispatcherDeps<S>): Dispatcher => {
  const events = deps.events ?? createAppEventBus();
  const cancellation = deps.cancellation ?? createCancellationRegistry();
  const dedupe = deps.dedupe ?? createCidDedupeCache();
  const now = deps.now ?? (() => Date.now());
  const log = deps.logSink;

  let interactiveInflight = 0;
  let maintenanceInflight = 0;

  const waiters = new Map<string, (r: TerminalRecord) => void>();

  const resolveWaiter = (terminal: TerminalRecord): void => {
    const waiter = waiters.get(terminal.cid);
    if (waiter !== undefined) {
      waiters.delete(terminal.cid);
      waiter(terminal);
    }
  };

  const publishTerminal = (terminal: TerminalRecord): void => {
    if (terminal.cancelled)
      events.publish({ type: 'command-cancelled', cid: terminal.cid, command: terminal.name });
    if (terminal.result.ok)
      events.publish({
        type: 'command-applied',
        cid: terminal.cid,
        command: terminal.name,
        result: terminal.result.value,
      });
    else
      events.publish({
        type: 'command-failed',
        cid: terminal.cid,
        command: terminal.name,
        error: terminal.result.error,
      });
  };

  const finish = (
    message: ValidatedMessage,
    lane: Lane,
    startedAt: number,
    result: Result<unknown, LedgeError>,
    cancelled: boolean,
    countersAlreadyHeld: boolean,
  ): TerminalRecord => {
    if (countersAlreadyHeld) {
      if (lane === 'interactive') interactiveInflight -= 1;
      else maintenanceInflight -= 1;
    }
    log.write({
      cid: message.cid,
      name: message.name,
      kind: message.kind === 'query' ? 'query' : 'command',
      senderContext: message.senderContext,
      startedAt,
      durationMs: now() - startedAt,
      outcome: cancelled ? 'cancelled' : result.ok ? 'applied' : 'failed',
      lane,
      ...(result.ok ? {} : { errorCode: result.error.code }),
    });
    const terminal: TerminalRecord = {
      cid: message.cid,
      name: message.name,
      result,
      cancelled,
      durationMs: now() - startedAt,
      lane,
    };
    return terminal;
  };

  const laneOf = (kind: 'command' | 'query', lane: Lane | undefined): Lane =>
    kind === 'query' ? 'interactive' : (lane ?? 'interactive');

  const execute = (
    message: ValidatedMessage,
    registration: { readonly handler: Handler<S>; readonly lane?: Lane | undefined },
    kind: 'command' | 'query',
  ): void => {
    const startedAt = now();
    const lane = laneOf(kind, registration.lane);
    if (lane === 'interactive') interactiveInflight += 1;
    else maintenanceInflight += 1;
    const token = cancellation.register(message.cid);
    const progress = emitterFor(message.cid, message.name, (event) =>
      events.publish({ type: 'progress', event }),
    );
    const notifyPending = (intentId: string): void => {
      events.publish({
        type: 'command-ack',
        cid: message.cid,
        command: message.name,
        intentId,
      });
    };
    const operation = operationLabel(kind, message.name);
    const ctx: HandlerCtx<S> = {
      message,
      services: deps.services,
      token,
      progress,
      notifyPending,
      now,
    };
    void (async (): Promise<TerminalRecord> => {
      try {
        const raw = await registration.handler(ctx);
        const result: Result<unknown, LedgeError> = raw.ok
          ? raw
          : err(toApplicationError(raw.error, operation));
        return finish(message, lane, startedAt, result, token.isCancelled(), true);
      } catch (e) {
        if (isCancelledMarker(e)) {
          return finish(
            message,
            lane,
            startedAt,
            err(cancelledTerminalError(operation, message.cid)),
            true,
            true,
          );
        }
        return finish(message, lane, startedAt, err(toApplicationError(e, operation)), false, true);
      } finally {
        cancellation.forget(message.cid);
      }
    })()
      .then((terminal) => {
        publishTerminal(terminal);
        if (kind === 'command') dedupe.record(message.cid, message.name, now(), terminal);
        resolveWaiter(terminal);
      })
      .catch((defect: unknown) => {
        // Absolute backstop: a defect INSIDE finish/publish itself. Counter release is
        // idempotent only on the held path — a held-counter defect would be logged by
        // diagnostics wiring; keep invariants intact here.
        void defect;
      });
  };

  const admit = (
    message: ValidatedMessage,
    kind: 'command' | 'query',
    registration: { readonly handler: Handler<S>; readonly lane?: Lane | undefined },
  ): Lane | 'shed' => {
    const lane = laneOf(kind, registration.lane);
    const operation = operationLabel(kind, message.name);
    const saturates =
      lane === 'maintenance'
        ? maintenanceInflight >= MAINTENANCE_INFLIGHT_CAP + MAINTENANCE_QUEUE_CAP
        : interactiveInflight >= INTERACTIVE_INFLIGHT_CAP;
    const pressured = lane === 'maintenance' && maintenanceInflight >= MAINTENANCE_INFLIGHT_CAP;
    if (!saturates && !pressured) return lane;
    // §2.6 failure law: shed honestly over the bus — never a silent drop, never an
    // interactive starvation (interactive sheds only at its own saturation).
    const shedError = ledgeError('E_RATE_LANESHED', { operation });
    const startedAt = now();
    log.write({
      cid: message.cid,
      name: message.name,
      kind,
      senderContext: message.senderContext,
      startedAt,
      durationMs: now() - startedAt,
      outcome: 'failed',
      lane,
      errorCode: shedError.code,
    });
    const shedTerminal: TerminalRecord = {
      cid: message.cid,
      name: message.name,
      result: err(shedError),
      cancelled: false,
      durationMs: now() - startedAt,
      lane,
    };
    publishTerminal(shedTerminal);
    resolveWaiter(shedTerminal);
    return 'shed';
  };

  return {
    dispatch: (raw, zone) => {
      const validated =
        deps.internal !== undefined
          ? validateInternalMessage(raw, { zone, roster: deps.internal })
          : validateMessage(raw, { zone });
      if (validated.type === 'ignored')
        return { outcome: 'ignored', reason: validated.reason, name: validated.name };
      if (validated.type === 'rejected') return { outcome: 'rejected', error: validated.error };

      const message = validated.message;
      // The dispatcher serves commands and queries only; event/stream wire kinds are
      // SW-originated (§3.5) — an inbound one is not an error, it's silent noise.
      if (message.kind !== 'command' && message.kind !== 'query')
        return { outcome: 'ignored', reason: 'kind-not-served', name: message.name };
      const kind = message.kind;

      if (kind === 'command') {
        const cached = dedupe.lookup(message.cid, message.name, now());
        if (cached !== undefined) {
          const terminal = cached.outcome as TerminalRecord;
          publishTerminal(terminal);
          resolveWaiter(terminal);
          return { outcome: 'ack', cid: message.cid };
        }
      }

      const registration =
        kind === 'query' ? deps.registry.query(message.name) : deps.registry.command(message.name);
      if (registration === undefined) {
        const error = ledgeError('E_CAPABILITY', {
          operation: operationLabel(kind, message.name),
          fault: 'no-handler',
        });
        log.write({
          cid: message.cid,
          name: message.name,
          kind,
          senderContext: message.senderContext,
          startedAt: now(),
          durationMs: 0,
          outcome: 'ignored',
          lane: 'interactive',
          errorCode: error.code,
        });
        return { outcome: 'ignored', reason: 'no-handler', name: message.name };
      }

      const lane = admit(message, kind, registration);
      if (lane === 'shed') return { outcome: 'ack', cid: message.cid };
      execute(message, registration, kind);
      return { outcome: 'ack', cid: message.cid };
    },

    terminalOf: (cid) =>
      new Promise<TerminalRecord>((resolve) => {
        waiters.set(cid, resolve);
      }),

    cancel: (cid) => cancellation.cancel(cid),

    inflight: () => ({
      interactive: interactiveInflight,
      maintenance: maintenanceInflight,
    }),

    events,
  };
};
