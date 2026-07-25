// E2-T02 state-machine law tests — the two-phase write pattern in isolation:
// atomic acceptance, cid dedupe, exactly-once terminals, terminal conflicts,
// hinge abort-totality (a poisoned batch takes the intent row down with it).
import { describe, expect, it } from 'vitest';
import type { IntentRecord } from '@/application/ports/intent-ledger.port.js';
import {
  abortedEnv,
  acceptInputOf,
  allEvents,
  expectRow,
  makeLedger,
  parkedEnv,
  respawnLedger,
} from './testkit.js';

describe('intents ledger acceptance (ADR-011 phase 1)', () => {
  it('accept commits ack event + ledger row + cid map in one proof', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    const r = await h.ledger.accept(input);
    if (!r.ok) throw new Error(`accept failed: ${r.error.code}`);
    expect(r.value.deduped).toBe(false);
    const row = await expectRow(h, input.intentId);
    expect(row.state).toBe('intent');
    expect(row.cid).toBe(input.cid);
    expect(row.retryCount).toBe(0);
    const events = await allEvents(h);
    expect(events.map((e) => e.envelope.type)).toEqual(['ParkIntentAccepted']);
    await h.engine.close();
  });

  it('duplicate accept by cid returns the durable original — no events, no rows', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    const again = await h.ledger.accept({ ...input });
    if (!again.ok) throw new Error('duplicate accept failed');
    expect(again.value.deduped).toBe(true);
    expect(again.value.record.intentId).toBe(input.intentId);
    expect(await allEvents(h)).toHaveLength(1);
    // A resend carrying a NEW intentId under the same cid still dedupes by cid
    // (§3.3 resend law is cid-keyed, independent of caller id-minting discipline).
    const respawned = respawnLedger(h);
    const third = await respawned.accept({ ...input, intentId: acceptInputOf(2, 2).intentId });
    if (!third.ok) throw new Error('respawned accept failed');
    expect(third.value.deduped).toBe(true);
    expect(third.value.record.intentId).toBe(input.intentId);
    expect(await allEvents(h)).toHaveLength(1);
    await h.engine.close();
  });

  it('intentId reuse under a different cid is an integrity violation', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    const alien = { ...input, cid: acceptInputOf(2, 2).cid, ackEvents: input.ackEvents };
    const r = await h.ledger.accept(alien);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_JOURNAL_INTEGRITY');
      expect(r.error.details?.['raw']).toBe('intent-id-reuse');
    }
    await h.engine.close();
  });

  it('poisoned acceptance batch ⇒ the row and cid map are aborted with it (one fate)', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    // Journal law violation inside the batch (seq gap) must kill the WHOLE txn.
    const first = input.ackEvents.at(0);
    if (first === undefined) throw new Error('fixture broken');
    const poisoned = {
      ...input,
      ackEvents: [
        {
          ...first,
          eventId: acceptInputOf(9, 1).intentId,
          hlc: { ...first.hlc, seq: 7 },
        },
      ],
    };
    const r = await h.ledger.accept(poisoned);
    expect(r.ok).toBe(false);
    const pending = await h.ledger.pending();
    if (!pending.ok) throw new Error('pending failed');
    expect(pending.value).toEqual([]);
    expect(await allEvents(h)).toEqual([]);
    await h.engine.close();
  });
});

describe('intents ledger terminal laws (ADR-011 phase 4)', () => {
  const setup = async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    return { h, input };
  };

  it('complete commits terminal event + row; replaying the same completion adds nothing', async () => {
    const { h, input } = await setup();
    const done = await h.ledger.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 3_000);
    if (!done.ok) throw new Error(`complete failed: ${done.error.code}`);
    expect(done.value.state).toBe('done');
    expect(done.value.resolvedAt).toBe(3_000);

    const replay = await h.ledger.complete(
      input.intentId,
      [parkedEnv(2, input.intentId, 1)],
      3_000,
    );
    if (!replay.ok) throw new Error('terminal replay failed');
    expect(replay.value.state).toBe('done');
    expect((await allEvents(h)).map((e) => e.envelope.type)).toEqual([
      'ParkIntentAccepted',
      'TabsParked',
    ]);
    const pending = await h.ledger.pending();
    if (!pending.ok) throw new Error('pending failed');
    expect(pending.value).toEqual([]);
    await h.engine.close();
  });

  it('conflicting completion content ⇒ integrity violation (journal alien-content law)', async () => {
    const { h, input } = await setup();
    await h.ledger.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 3_000);
    // A genuinely alien completion: fresh eventId, diverging count — same idem key.
    const alien = await h.ledger.complete(
      input.intentId,
      [parkedEnv(3, input.intentId, 999)],
      4_000,
    );
    expect(alien.ok).toBe(false);
    if (!alien.ok) expect(alien.error.details?.['raw']).toBe('idempotency-key-reuse');
    await h.engine.close();
  });

  it('abort then complete ⇒ terminal conflict, zero new bytes committed', async () => {
    const { h, input } = await setup();
    const aborted = await h.ledger.abort(input.intentId, [abortedEnv(2, input.intentId, 1)], 3_000);
    if (!aborted.ok) throw new Error(`abort failed: ${aborted.error.code}`);
    expect(aborted.value.state).toBe('aborted');
    const conflicted = await h.ledger.complete(
      input.intentId,
      [parkedEnv(3, input.intentId, 1)],
      4_000,
    );
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.error.details?.['raw']).toBe('intent-terminal-conflict');
    expect((await allEvents(h)).map((e) => e.envelope.type)).toEqual([
      'ParkIntentAccepted',
      'ParkAborted',
    ]);
    await h.engine.close();
  });

  it('terminal attempt on a missing intent ⇒ intent-missing', async () => {
    const h = await makeLedger();
    const ghost = acceptInputOf(7, 1);
    const r = await h.ledger.complete(ghost.intentId, [parkedEnv(1, ghost.intentId, 1)], 2_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['raw']).toBe('intent-missing');
    expect(await allEvents(h)).toEqual([]);
    await h.engine.close();
  });

  it('noteRetry increments pending rows only (terminal rows are frozen)', async () => {
    const { h, input } = await setup();
    const bumped = await h.ledger.noteRetry(input.intentId);
    if (!bumped.ok) throw new Error('noteRetry failed');
    expect(bumped.value.retryCount).toBe(1);
    await h.ledger.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 3_000);
    const frozen = await h.ledger.noteRetry(input.intentId);
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.error.details?.['raw']).toBe('intent-terminal-conflict');
    await h.engine.close();
  });

  it('pending() is state-index covered and receives multiple dangling intents', async () => {
    const h = await makeLedger();
    await h.ledger.accept(acceptInputOf(1, 1));
    await h.ledger.accept(acceptInputOf(2, 2));
    await h.ledger.accept(acceptInputOf(3, 3));
    const pending = await h.ledger.pending();
    if (!pending.ok) throw new Error('pending failed');
    expect(pending.value.map((r: IntentRecord) => r.state)).toEqual(['intent', 'intent', 'intent']);
    const first = pending.value.at(0);
    if (first === undefined) throw new Error('fixture broken');
    await h.ledger.complete(first.intentId, [parkedEnv(4, first.intentId, 1)], 5_000);
    const after = await h.ledger.pending();
    if (!after.ok) throw new Error('pending 2 failed');
    expect(after.value).toHaveLength(2);
    await h.engine.close();
  });
});
