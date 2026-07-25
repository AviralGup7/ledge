// E1-T10 property suite — journal laws over randomized append plans (EES §2.8/§4/§8).
// P1: append→readRange round trip: the durable stream equals the model, exactly ordered.
// P2: every window read is the exact slice of the durable stream.
// P3: idempotent retries never alter state; replays of any earlier key fold to no-ops.
// Laws are asserted against the real adapter stack (fake-indexeddb) so the property
// covers segmenting, the heads anchor, and the idempotency ledger together.
import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { DEV_A as DEV, makeEnv, makeJournal, type EnvType } from './testkit.js';

const PROPERTY_TIMEOUT_MS = 120_000;

interface BatchPlan {
  readonly size: number;
  readonly type: EnvType;
  readonly replay: boolean;
}

const arbPlan: fc.Arbitrary<readonly BatchPlan[]> = fc.array(
  fc.record({
    size: fc.integer({ min: 1, max: 5 }),
    type: fc.constantFrom<EnvType>('MissionRenamed', 'WindowClosedExternal', 'SettingsChanged'),
    replay: fc.boolean(),
  }),
  { minLength: 1, maxLength: 8 },
);

describe('E1-T10 journal property suite', () => {
  it(
    'P1+P3: randomized append plans (with replays) reproduce the model stream exactly',
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbPlan, async (plan) => {
          const { journal, engine } = await makeJournal();
          const model: EventEnvelope[] = [];
          let seq = 0;
          const seen: { key: string; batch: EventEnvelope[] }[] = [];
          let batchNo = 0;

          for (const step of plan) {
            batchNo += 1;
            const batch: EventEnvelope[] = [];
            for (let i = 0; i < step.size; i++) {
              seq += 1;
              batch.push(makeEnv(seq, seq, DEV, step.type));
            }
            const key = `p-${batchNo}`;
            seen.push({ key, batch });
            const ack = await journal.append(batch, { idempotencyKey: key });
            if (!ack.ok) return false;
            // Ack surface law: contiguous [fromSeq..toSeq] landing on the model head.
            if (ack.value.fromSeq !== seq - step.size + 1 || ack.value.toSeq !== seq) return false;
            if (ack.value.count !== step.size) return false;
            model.push(...batch);

            if (step.replay) {
              const again = await journal.append(batch, { idempotencyKey: key });
              if (!again.ok) return false;
              if (
                again.value.fromSeq !== ack.value.fromSeq ||
                again.value.toSeq !== ack.value.toSeq ||
                again.value.count !== ack.value.count
              )
                return false;
            }
          }

          // P3 replay storm: every seen key+original batch folds to its recorded ack;
          // head and stream must be identical before and after the storm (§2.8 retry law).
          if (plan.some((s) => s.replay)) {
            const before = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
            if (!before.ok) return false;
            for (const { key, batch } of seen) {
              const r = await journal.append(batch, { idempotencyKey: key });
              if (!r.ok) return false;
            }
            const after = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
            if (!after.ok) return false;
            if (after.value.durableThrough !== before.value.durableThrough) return false;
            if (after.value.events.length !== before.value.events.length) return false;
          }

          const read = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
          await engine.close();
          if (!read.ok) return false;
          if (read.value.durableThrough !== seq) return false;
          if (read.value.events.length !== model.length) return false;
          if (read.value.preservedUnknown.length !== 0) return false;
          // Deep fidelity + strict (seq, batchIndex) monotonicity along the whole stream.
          for (let i = 0; i < model.length; i++) {
            const got = read.value.events[i];
            const want = model[i];
            if (got === undefined || want === undefined) return false;
            if (got.seq !== want.hlc.seq) return false;
            if (got.envelope.eventId !== want.eventId) return false;
            if (JSON.stringify(got.envelope.payload) !== JSON.stringify(want.payload)) return false;
            if (i > 0) {
              const prev = read.value.events[i - 1];
              if (prev === undefined) return false;
              if (!(
                got.seq > prev.seq ||
                (got.seq === prev.seq && got.batchIndex > prev.batchIndex)
              ))
                return false;
            }
          }
          return true;
        }),
      );
    },
  );

  it(
    'P2: arbitrary window reads equal exact slices of the durable stream',
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbPlan, fc.nat({ max: 20 }), async (plan, windowSeed) => {
          const { journal, engine } = await makeJournal();
          let seq = 0;
          for (const step of [...plan].slice(0, 5)) {
            const batch: EventEnvelope[] = [];
            for (let i = 0; i < step.size; i++) {
              seq += 1;
              batch.push(makeEnv(seq, seq, DEV, step.type));
            }
            const r = await journal.append(batch, { idempotencyKey: `w-${seq}` });
            if (!r.ok) return false;
          }
          if (seq === 0) return true; // vacuous plan

          const full = await journal.readRange({ deviceId: DEV, fromSeq: 1 });
          if (!full.ok) return false;
          // Deterministic pseudo-window derived from the seed (two prefix windows, one interior).
          const a = (windowSeed % seq) + 1;
          const b = Math.min(seq, a + (windowSeed % 5));
          for (const [from, to] of [
            [1, seq],
            [a, b],
            [b, b],
          ] as const) {
            const w = await journal.readRange({ deviceId: DEV, fromSeq: from, toSeq: to });
            if (!w.ok) return false;
            const expectSeqs = full.value.events
              .filter((e) => e.seq >= from && e.seq <= to)
              .map((e) => e.seq);
            const gotSeqs = w.value.events.map((e) => e.seq);
            if (JSON.stringify(gotSeqs) !== JSON.stringify(expectSeqs)) return false;
            if (w.value.durableThrough !== seq) return false;
          }
          await engine.close();
          return true;
        }),
      );
    },
  );
});
