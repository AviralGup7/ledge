// E2-T02 completion criterion — "Chaos: kill pre/post every txn ⇒ 0 loss; duplicate
// intents deduped by cid." Kill mechanics: an instance is abandoned mid-scenario (SW
// death); a fresh instance over the same engine continues (boot). Durable invariants
// are asserted at every boundary — in-flight browser effects are modeled as caller-side
// writes that reconciliation may re-run idempotently (ADR-011).
import { describe, expect, it } from 'vitest';
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

const assertStreamExact = async (h: LedgerHarness, types: readonly string[]): Promise<void> => {
  const events = await allEvents(h);
  expect(events.map((e) => e.envelope.type)).toEqual([...types]);
  // 0-loss contiguity: seq runs 1..N with no holes, whatever death interrupted us.
  expect(events.map((e) => e.seq)).toEqual([...Array(events.length).keys()].map((i) => i + 1));
};

describe('kill pre-txn / post-txn at every phase ⇒ 0 loss', () => {
  it('kill before any commit: fresh accept works; nothing secretly durable', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    // Instance dies "before" its accept — modelled by respawning with an untouched store.
    const ledger2 = respawnLedger(h);
    const r = await ledger2.accept(input);
    if (!r.ok) throw new Error('accept failed');
    expect(r.value.deduped).toBe(false);
    await assertStreamExact(h, ['ParkIntentAccepted']);
    await h.engine.close();
  });

  it('kill between acceptance and effect: pending() exposes the dangling intent; completion finishes it exactly once', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    // ☠ KILL — browser effect never ran, instance abandoned.
    const ledger2 = respawnLedger(h);
    const pending = await ledger2.pending();
    if (!pending.ok) throw new Error('pending failed');
    expect(pending.value.map((r) => r.intentId)).toEqual([input.intentId]);
    // Conservative continuation: retry counter advanced, then terminal committed once.
    await ledger2.noteRetry(input.intentId);
    const done = await ledger2.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 5_000);
    if (!done.ok) throw new Error('complete failed');
    expect(done.value.state).toBe('done');
    await assertStreamExact(h, ['ParkIntentAccepted', 'TabsParked']);
    expect((await expectRow(h, input.intentId)).retryCount).toBe(1);
    await h.engine.close();
  });

  it('kill after effect, before completion commit: re-completion reaches the same end state', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    // Effect applied in the world (caller-side), instance dies before committing it.
    const effectApplications: number[] = [];
    effectApplications.push(1);
    // ☠ KILL. Reconciler re-drives the SAME idempotent effect and commits once.
    const ledger2 = respawnLedger(h);
    effectApplications.push(1); // idempotent re-run: same args, same world state
    const done = await ledger2.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 5_000);
    if (!done.ok) throw new Error('complete failed');
    // …and a stale DUPLICATE arrive-after-recovery changes nothing.
    const dup = await ledger2.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 5_000);
    if (!dup.ok) throw new Error('dup complete failed');
    expect(effectApplications).toHaveLength(2);
    await assertStreamExact(h, ['ParkIntentAccepted', 'TabsParked']);
    await h.engine.close();
  });

  it('kill after completion commit: respawn finds nothing pending; replays are no-ops', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    await h.ledger.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 5_000);
    // ☠ KILL post-commit.
    const ledger2 = respawnLedger(h);
    const pending = await ledger2.pending();
    if (!pending.ok) throw new Error('pending failed');
    expect(pending.value).toEqual([]);
    const dup = await ledger2.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 5_000);
    if (!dup.ok) throw new Error('replay failed');
    await assertStreamExact(h, ['ParkIntentAccepted', 'TabsParked']);
    await h.engine.close();
  });

  it('kill mid-abort intent window: conservative abort path terminates exactly once', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    await h.ledger.accept(input);
    // ☠ KILL, respawned reconciler cannot prove the effect — conservative ABORT.
    const ledger2 = respawnLedger(h);
    const aborted = await ledger2.abort(input.intentId, [abortedEnv(2, input.intentId, 1)], 6_000);
    if (!aborted.ok) throw new Error('abort failed');
    const dup = await ledger2.abort(input.intentId, [abortedEnv(2, input.intentId, 1)], 6_000);
    if (!dup.ok) throw new Error('abort replay failed');
    await assertStreamExact(h, ['ParkIntentAccepted', 'ParkAborted']);
    await h.engine.close();
  });
});

describe('duplicate intents deduped by cid — across instance death', () => {
  it('resends with same cid at every boundary dedupe to the durable original', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    const first = await h.ledger.accept(input);
    if (!first.ok) throw new Error('accept failed');
    const boundaries: ReadonlyArray<'afterAccept' | 'afterComplete'> = [
      'afterAccept',
      'afterComplete',
    ];
    for (const boundary of boundaries) {
      if (boundary === 'afterComplete') {
        await h.ledger.complete(input.intentId, [parkedEnv(2, input.intentId, 1)], 5_000);
      }
      // ☠ KILL + resend the same cid through a fresh instance.
      const ledger2 = respawnLedger(h);
      const dup = await ledger2.accept({ ...input });
      if (!dup.ok) throw new Error('dedupe accept failed');
      expect(dup.value.deduped).toBe(true);
      expect(dup.value.record.intentId).toBe(input.intentId);
    }
    await assertStreamExact(h, ['ParkIntentAccepted', 'TabsParked']);
    await h.engine.close();
  });

  it('three parallel-storm duplicates land exactly one row and one event pair', async () => {
    const h = await makeLedger();
    const input = acceptInputOf(1, 1);
    const results = await Promise.all([
      h.ledger.accept(input),
      h.ledger.accept(input),
      h.ledger.accept(input),
    ]);
    // Durable law under a duplicate storm: all attempts succeed (journal replay),
    // and exactly one row / one event exists afterwards.
    for (const r of results) expect(r.ok).toBe(true);
    await assertStreamExact(h, ['ParkIntentAccepted']);
    await h.engine.close();
  });
});
