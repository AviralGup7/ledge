// E2-T02 property suite — randomized operation scripts (accept / resend / complete /
// abort / retry / kill-respawn) against a linearizable model. Law: at every step the
// durable store (journal events + intent rows + pending set) equals the model; instance
// death anywhere changes nothing durable.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IntentState } from '@/application/ports/intent-ledger.port.js';
import {
  abortedEnv,
  acceptInputOf,
  allEvents,
  expectRow,
  makeLedger,
  parkedEnv,
  respawnLedger,
  type LedgerHarness,
} from './testkit.js';
import type { IntentLedgerPort } from '@/application/ports/intent-ledger.port.js';
import type { Id } from '@/shared-kernel/identity/id.js';

type Op =
  | { readonly kind: 'accept'; readonly n: number }
  | { readonly kind: 'resend'; readonly n: number }
  | { readonly kind: 'complete'; readonly n: number }
  | { readonly kind: 'abort'; readonly n: number }
  | { readonly kind: 'retry'; readonly n: number }
  | { readonly kind: 'killRespawn' };

const opArb: fc.Arbitrary<Op> = fc.integer({ min: 1, max: 3 }).chain((n) =>
  fc.oneof(
    fc.constant({ kind: 'accept', n } as const),
    fc.constant({ kind: 'accept', n } as const), // weighted: acceptance is common
    fc.constant({ kind: 'resend', n } as const),
    fc.constant({ kind: 'complete', n } as const),
    fc.constant({ kind: 'abort', n } as const),
    fc.constant({ kind: 'retry', n } as const),
    fc.constant({ kind: 'killRespawn' } as const),
  ),
);

interface ModelSlot {
  state: IntentState | 'absent';
  retries: number;
}

/** Event types the model expects in-order, per script prefix. */
interface Model {
  readonly slots: Readonly<Record<number, ModelSlot>>;
  readonly eventTypes: string[];
}

const freshModel = (): Model => ({
  slots: {
    1: { state: 'absent', retries: 0 },
    2: { state: 'absent', retries: 0 },
    3: { state: 'absent', retries: 0 },
  },
  eventTypes: [],
});

const INTENT_PROPERTY_TIMEOUT_MS = 600_000;

describe('E2-T02 ledger linearizability (scripts × kills)', () => {
  it(
    'any operation script leaves durable state equal to the model',
    { timeout: INTENT_PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (script) => {
          const h: LedgerHarness = await makeLedger();
          let ledger: IntentLedgerPort = h.ledger;
          let seq = 0;
          const model = freshModel();
          const intentIds: Record<number, Id | undefined> = {};
          const issuedAts: Record<number, number | undefined> = {};

          for (const op of script) {
            if (op.kind === 'killRespawn') {
              ledger = respawnLedger(h); // ☠ instance death is state-neutral, no seq spent
              continue;
            }
            const n = op.n;
            const slot = model.slots[n] as ModelSlot;
            if (op.kind === 'accept' || op.kind === 'resend') {
              if (slot.state === 'absent') {
                seq += 1; // only event-emitting steps spend stream seq
              }
              const input = acceptInputOf(n, seq);
              let effective = input;
              if (slot.state === 'absent') {
                (model.eventTypes as string[]).push('ParkIntentAccepted');
                intentIds[n] = input.intentId;
                issuedAts[n] = input.issuedAt;
                (model.slots as Record<number, ModelSlot>)[n] = { state: 'intent', retries: 0 };
              } else {
                // Lawful resend: recycle the caller-deterministic identity pair.
                const prior = intentIds[n];
                if (prior === undefined) throw new Error('model broken');
                effective = { ...input, intentId: prior };
              }
              const r = await ledger.accept(effective);
              const events = await allEvents(h);
              if (!r.ok) throw new Error(`accept failed: ${r.error.code}`);
              expect(r.value.deduped).toBe(slot.state !== 'absent');
              expect(events.map((e) => e.envelope.type)).toEqual(model.eventTypes);
              continue;
            }
            const intentId = intentIds[n];
            if (intentId === undefined) {
              // Ops on never-accepted intents are integrity violations, not silent no-ops.
              if (op.kind === 'complete') {
                const r = await ledger.complete(
                  acceptInputOf(n, seq).intentId,
                  [parkedEnv(seq, acceptInputOf(n, seq).intentId, 1)],
                  9_000 + seq,
                );
                expect(r.ok).toBe(false);
              }
              continue;
            }
            if (op.kind === 'retry' && slot.state === 'intent') {
              const r = await ledger.noteRetry(intentId);
              if (!r.ok) throw new Error('noteRetry failed');
              (model.slots as Record<number, ModelSlot>)[n] = {
                state: 'intent',
                retries: slot.retries + 1,
              };
              continue;
            }
            if (op.kind === 'complete' && slot.state === 'intent') {
              seq += 1;
              const r = await ledger.complete(intentId, [parkedEnv(seq, intentId, 1)], 9_000 + seq);
              if (!r.ok) throw new Error(`complete failed: ${r.error.code}`);
              (model.eventTypes as string[]).push('TabsParked');
              (model.slots as Record<number, ModelSlot>)[n] = {
                state: 'done',
                retries: slot.retries,
              };
              // Re-completion in the same script (post-completion resend) dedupes:
              const replay = await ledger.complete(
                intentId,
                [parkedEnv(seq, intentId, 1)],
                9_000 + seq,
              );
              if (!replay.ok) throw new Error('completion replay failed');
              continue;
            }
            if (op.kind === 'abort' && slot.state === 'intent') {
              seq += 1;
              const r = await ledger.abort(intentId, [abortedEnv(seq, intentId, 1)], 9_000 + seq);
              if (!r.ok) throw new Error(`abort failed: ${r.error.code}`);
              (model.eventTypes as string[]).push('ParkAborted');
              (model.slots as Record<number, ModelSlot>)[n] = {
                state: 'aborted',
                retries: slot.retries,
              };
              continue;
            }
          }

          // Final equivalence sweep: events, pending set, per-slot row state, retries.
          const events = await allEvents(h);
          expect(events.map((e) => e.envelope.type)).toEqual(model.eventTypes);
          expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
            [...Array(events.length).keys()].map((i) => i + 1),
          );
          const pending = await ledger.pending();
          if (!pending.ok) throw new Error('pending failed');
          const pendingIds = new Set(pending.value.map((r) => r.intentId as string));
          for (const n of [1, 2, 3]) {
            const slot = model.slots[n] as ModelSlot;
            const intentId = intentIds[n];
            if (intentId === undefined) continue;
            const row = await expectRow(h, intentId);
            if (slot.state === 'intent') {
              expect(pendingIds.has(intentId)).toBe(true);
            }
            expect(row.state).toBe(slot.state);
            expect(row.retryCount).toBe(slot.retries);
          }
          await h.engine.close();
        }),
      );
    },
  );
});
