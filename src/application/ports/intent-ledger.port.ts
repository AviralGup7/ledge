// E2-T02 · IntentLedgerPort — ADR-011's two-phase durability machine, EES §5 'intents'
// row, §10-R1/R2 race law. Every browser-affecting operation flows: (1) intent event +
// ledger row committed in ONE txn (the EES §5 law-2 durability hinge), (2) ack ⇒ caller
// may mutate, (3) execution (caller-side, outside any txn), (4) completion event + row
// terminal, again one txn. Kill anywhere ⇒ nothing half-committed; boot reconciliation
// (E2-T06) walks pending() and resolves conservatively.
//
// Failure taxonomy: conflicts/missing/reuse are durable-integrity facts ⇒
// E_JOURNAL_INTEGRITY with discriminators raw ∈
// {'intent-missing','intent-terminal-conflict','intent-id-reuse'} (JournalPort family
// law); journal-side retry law keeps its own 'idempotency-key-reuse' for alien content.
import type { Id } from '@/shared-kernel/identity/id.js';
import type { StoreName, TxScope } from './storage-engine.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';

/** EES §5 state column: accepted-pending | terminal-done | terminal-aborted. */
export type IntentState = 'intent' | 'done' | 'aborted';

/**
 * intents store row (EES §5): intentId → {state, scope, issuedAt, resolvedAt,
 * retryCount} plus audit fields (cid, kind). 'Resolved intents archived after 30d'
 * is a reconciler concern (E2-T06); the ledger rows stay until it sweeps.
 * (Type alias — rows stored through StoredRecord need an implicit index signature.)
 */
export type IntentRecord = {
  readonly intentId: Id;
  /** Client op id (wire cid). §3.3 resend law + task law: duplicate cid ⇒ deduped. */
  readonly cid: Id;
  /** Wire command name that birthed this intent (audit trail; never re-dispatched). */
  readonly kind: string;
  readonly scope: unknown;
  readonly state: IntentState;
  readonly issuedAt: number;
  readonly resolvedAt?: number | undefined;
  readonly retryCount: number;
};

export interface AcceptInput {
  readonly intentId: Id;
  readonly cid: Id;
  readonly kind: string;
  readonly scope: unknown;
  /** Informational wall stamp (§2.2: wallClock informational); caller-provided. */
  readonly issuedAt: number;
  /** Durable acceptance event(s), caller-stamped (ParkIntentAccepted family). */
  readonly ackEvents: readonly EventEnvelope[];
  /**
   * E3-APP · §6.4 \"txn A, same\" law: acceptance may carry CALLER co-writes (the park
   * flow's SnapshotTaken + session part rows) inside the SAME idb transaction as the
   * ack events + intent row + cid map. Ordered AFTER the ledger's own hinge writes;
   * any throw aborts everything (one fate). Dedupe replay skips it with the hinge —
   * the durable original already contains it. Additive-optional (ADR-011 unchanged).
   */
  readonly extraStores?: readonly StoreName[] | undefined;
  readonly hinge?: ((tx: TxScope) => Promise<void>) | undefined;
}

export interface AcceptOutcome {
  readonly record: IntentRecord;
  /** true ⇒ an existing durable intent for this cid was returned; nothing re-written. */
  readonly deduped: boolean;
}

export interface IntentLedgerPort {
  /**
   * Phase 1: commit acceptance (ack event(s) + ledger row + cid map) in one txn.
   * Idempotent by cid (ADR-011 / §3.3): a resend returns the durable original.
   * A different cid under a taken intentId ⇒ E_JOURNAL_INTEGRITY raw='intent-id-reuse'.
   */
  accept(input: AcceptInput): Promise<Result<AcceptOutcome, LedgeError>>;
  /**
   * Phase 4: commit terminal-done (completion event(s) + row) in one txn.
   * Exactly-once by journal retry law: replaying the SAME completion events replays the
   * ack with zero new bytes; conflicting completion content ⇒ E_JOURNAL_INTEGRITY.
   */
  complete(
    intentId: Id,
    events: readonly EventEnvelope[],
    resolvedAt: number,
  ): Promise<Result<IntentRecord, LedgeError>>;
  /** Phase 4 mirror: commit terminal-aborted (ParkAborted family). */
  abort(
    intentId: Id,
    events: readonly EventEnvelope[],
    resolvedAt: number,
  ): Promise<Result<IntentRecord, LedgeError>>;
  /** Dangling scan for the boot reconciler (state='intent', state-index covered). */
  pending(): Promise<Result<readonly IntentRecord[], LedgeError>>;
  /** Retry accounting for conservative re-drives (boot/reconciler); row must be pending. */
  noteRetry(intentId: Id): Promise<Result<IntentRecord, LedgeError>>;
}
