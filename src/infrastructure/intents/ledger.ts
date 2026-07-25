// E2-T02 · intent ledger (ADR-011, EES §5 'intents', §10-R1/R2). Only the durability
// state machine lives here: the hub/use-cases own WHAT to do with a browser; this
// module guarantees the write pattern (ack → mutate → completion) can never half-commit
// and reruns dedupe to the durable original. Journal retry law supplies exactly-once
// terminal events; the cid map (meta) supplies cross-restart duplicate suppression.
import type {
  AcceptInput,
  AcceptOutcome,
  IntentLedgerPort,
  IntentRecord,
} from '@/application/ports/intent-ledger.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort, TxScope } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { Id } from '@/shared-kernel/identity/id.js';
import { err, ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

/** meta row wrapper: §5 meta is key → value. */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

/**
 * cid → intentId map (meta). Duplicates must dedupe across RESTARTS — an in-memory map
 * dies with the SW. Pruned with the 30d intent archive sweep (reconciler ownership).
 */
const META_INTENT_CID_MAP_KEY = 'intent.cidMap';

type CidMap = Record<string, string>;

const journalKey = (phase: 'accept' | 'complete' | 'abort', intentId: Id): string =>
  `intent-${phase}:${intentId}`;

const integrity = (
  raw: 'intent-missing' | 'intent-terminal-conflict' | 'intent-id-reuse',
  details: Record<string, string | number | boolean | null>,
): LedgeError => ledgeError('E_JOURNAL_INTEGRITY', { raw, ...details });

export interface IntentLedgerDeps {
  readonly engine: StorageEnginePort;
  readonly journal: Pick<JournalPort, 'appendHinged'>;
}

export function createIntentLedger(deps: IntentLedgerDeps): IntentLedgerPort {
  const { engine, journal } = deps;

  const readCidMap = async (tx: TxScope): Promise<CidMap> => {
    const row = await tx.table<MetaRow>('meta').get(META_INTENT_CID_MAP_KEY);
    return (row?.value ?? {}) as CidMap;
  };

  /** Terminal shared body (complete/abort): one hinged txn, journal idem-guarded. */
  const settle = async (
    intentId: Id,
    phase: 'complete' | 'abort',
    terminalState: 'done' | 'aborted',
    events: readonly EventEnvelope[],
    resolvedAt: number,
  ): Promise<Result<IntentRecord, LedgeError>> => {
    const appended = await journal.appendHinged(events, {
      idempotencyKey: journalKey(phase, intentId),
      extraStores: ['intents'],
      hinge: async (tx) => {
        const intents = tx.table<IntentRecord>('intents');
        const row = await intents.get(intentId);
        if (row === undefined) throw integrity('intent-missing', { intentId });
        if (row.state !== 'intent') {
          throw integrity('intent-terminal-conflict', {
            intentId,
            state: row.state,
            attempted: terminalState,
          });
        }
        await intents.put({ ...row, state: terminalState, resolvedAt });
      },
    });
    if (!appended.ok) return appended;
    // Post-commit read mirrors the caller's view of the now-terminal row. Idem-key
    // replay reaches the same row state (hinge skipped only when bytes were seen).
    const rowR = await engine.txn(['intents'], 'readonly', (tx) =>
      tx.table<IntentRecord>('intents').get(intentId),
    );
    if (!rowR.ok) return rowR;
    if (rowR.value === undefined) return err(integrity('intent-missing', { intentId }));
    return { ok: true, value: rowR.value };
  };

  return {
    async accept(input: AcceptInput): Promise<Result<AcceptOutcome, LedgeError>> {
      // Dedupe probe (single-writer SW ⇒ no interleave with the hinged write below).
      // Both keys are checked deterministically here — the journal's replay law can
      // legitimately skip the hinge, so id-collision law cannot live only in the hinge.
      const probe = await engine.txn(
        ['meta', 'intents'],
        'readonly',
        async (tx): Promise<IntentRecord | undefined> => {
          const intents = tx.table<IntentRecord>('intents');
          const byId = await intents.get(input.intentId);
          if (byId !== undefined) {
            if (byId.cid !== input.cid) {
              throw integrity('intent-id-reuse', { intentId: input.intentId });
            }
            return byId;
          }
          const map = await readCidMap(tx);
          const existingId = map[input.cid as string];
          if (existingId === undefined) return undefined;
          const byCid = await intents.get(existingId as Id);
          // A cid mapping without its row is a store integrity violation (they commit
          // in one txn) — dedupe must not paper over torn state.
          if (byCid === undefined) {
            throw integrity('intent-missing', { intentId: existingId });
          }
          return byCid;
        },
      );
      if (!probe.ok) return probe;
      if (probe.value !== undefined) {
        return { ok: true, value: { record: probe.value, deduped: true } };
      }

      const record: IntentRecord = {
        intentId: input.intentId,
        cid: input.cid,
        kind: input.kind,
        scope: input.scope,
        state: 'intent',
        issuedAt: input.issuedAt,
        retryCount: 0,
      };
      const appended = await journal.appendHinged(input.ackEvents, {
        idempotencyKey: journalKey('accept', input.intentId),
        extraStores: ['intents', 'meta'],
        hinge: async (tx) => {
          // Defensive id law: intentId is caller-minted-per-cid in hub policy; a taken
          // id under a different cid is a caller bug, never a silent replace.
          const intents = tx.table<IntentRecord>('intents');
          const existing = await intents.get(input.intentId);
          if (existing !== undefined) {
            if (existing.cid !== input.cid) {
              throw integrity('intent-id-reuse', { intentId: input.intentId });
            }
            return; // identical re-accept riding the journal replay — lawful no-op
          }
          await intents.put(record);
          const map = await readCidMap(tx);
          map[input.cid as string] = input.intentId as string;
          await tx.table<MetaRow>('meta').put({ key: META_INTENT_CID_MAP_KEY, value: map });
        },
      });
      if (!appended.ok) return appended;
      return { ok: true, value: { record, deduped: false } };
    },

    complete: (intentId, events, resolvedAt) =>
      settle(intentId, 'complete', 'done', events, resolvedAt),

    abort: (intentId, events, resolvedAt) =>
      settle(intentId, 'abort', 'aborted', events, resolvedAt),

    pending: () =>
      engine.txn(['intents'], 'readonly', (tx) =>
        tx
          .table<IntentRecord>('intents')
          .byIndex({ kind: 'equals', name: 'state', value: 'intent' }),
      ),

    noteRetry: (intentId) =>
      engine.txn(['intents'], 'readwrite', async (tx) => {
        const intents = tx.table<IntentRecord>('intents');
        const row = await intents.get(intentId);
        if (row === undefined) throw integrity('intent-missing', { intentId });
        if (row.state !== 'intent') {
          throw integrity('intent-terminal-conflict', { intentId, state: row.state });
        }
        const bumped: IntentRecord = { ...row, retryCount: row.retryCount + 1 };
        await intents.put(bumped);
        return bumped;
      }),
  };
}
