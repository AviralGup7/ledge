// E3-APP · Dispatch core types (EES §2.6 hub invariants) — one shape for command and
// query handlers, one execution context, one terminal model. Everything the observable
// law demands rides the context: cancellation token, progress emitter, structured log,
// monotonic clock.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { ValidatedMessage } from '../../contracts/validate.js';
import type { CancelToken } from './cancellation.js';
import type { ProgressEmitter } from './progress.js';

/** Priority classes (§2.6: interactive > maintenance; shed maintenance under pressure). */
export type Lane = 'interactive' | 'maintenance';

/** Execution context a handler is invoked with (S = service registry the root composed). */
export interface HandlerCtx<S> {
  /** The validated, normalized wire message (payload already stripped per §3.1 c). */
  readonly message: ValidatedMessage;
  /** Application services (use-case facades) — the handler's only mutation reach. */
  readonly services: S;
  /** Cooperative cancellation (registry-backed; observe at phase boundaries). */
  readonly token: CancelToken;
  /** Progress channel (monotonic stages; outbox translates to family streams). */
  readonly progress: ProgressEmitter;
  /** Two-phase law (§3.5 CommandAck): notify an accepted-pending intent binding. */
  readonly notifyPending: (intentId: string) => void;
  /** Injected clock (dispatcher records timing; tests control it). */
  readonly now: () => number;
}

/** Handler payload type flows from contracts' normalized payload (Record). */
export type Handler<S> = (ctx: HandlerCtx<S>) => Promise<Result<unknown, LedgeError>>;

/**
 * Registration row. lane defaults interactive; neverAutoRetry encodes §3.3 catalog
 * notes (C11 confirm-gated, C18 ambiguity, C15/C17/C25 irreversible — a transport that
 * auto-retries would turn single confirmed gestures into repeated destruction).
 */
export interface CommandRegistration<S> {
  readonly name: string;
  readonly handler: Handler<S>;
  readonly lane?: Lane;
  readonly neverAutoRetry?: boolean;
}

/** Queries are read-only but ride the identical observable harness. */
export interface QueryRegistration<S> {
  readonly name: string;
  readonly handler: Handler<S>;
}

/** Dispatch-level answer for the transport (terminals flow on app-events/streams). */
export type DispatchAnswer =
  | { readonly outcome: 'ack'; readonly cid: string }
  | { readonly outcome: 'ignored'; readonly reason: string; readonly name?: string | undefined }
  | { readonly outcome: 'rejected'; readonly error: LedgeError };

/** Terminal record a caller in-process may await (tests, SW-internal callers). */
export interface TerminalRecord {
  readonly cid: string;
  readonly name: string;
  readonly result: Result<unknown, LedgeError>;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly lane: Lane;
}
