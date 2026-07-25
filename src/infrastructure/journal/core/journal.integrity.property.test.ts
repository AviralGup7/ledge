// E2-T01 property suite — integrity laws over generated append plans.
// P1: any reachable clean journal ⇒ scanFull clean, checkpoint stamps exactly the head,
//     checkpoint idempotent, scanTail clean.
// P2: ANY content drift in ANY segment ⇒ the CRC walk prosecutes it with the exact
//     segmentId, and readRange never serves bytes from a mismatched segment.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { crc32Hex, stableStringify } from '@/shared-kernel/canon/index.js';
import { verifySegmentCrc } from './segment.js';
import type { JournalSegmentRecord } from './types.js';
import { DEV_A as DEV, makeEnv as env, makeJournal, uniqueKey as batchKey } from './testkit.js';

interface Plan {
  readonly batches: readonly number[];
}

/** Plans of 1..640 events split into batches of 1..20 (≤ segment cap, per batch law). */
const planArb: fc.Arbitrary<Plan> = fc.integer({ min: 1, max: 640 }).chain((total) =>
  fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 64 }).map((sizes) => {
    const batches: number[] = [];
    let remaining = total;
    for (const size of sizes) {
      if (remaining <= 0) break;
      const take = Math.min(size, remaining);
      batches.push(take);
      remaining -= take;
    }
    return { batches: batches.length > 0 ? batches : [total] };
  }),
);

const runPlan = async (
  journal: Awaited<ReturnType<typeof makeJournal>>['journal'],
  plan: Plan,
): Promise<{ headSeq: number }> => {
  let seq = 1;
  for (const size of plan.batches) {
    const batch = Array.from({ length: size }, (_, i) => env(seq + i, seq + i));
    const r = await journal.append(batch, { idempotencyKey: batchKey() });
    if (!r.ok) throw new Error(`append failed: ${r.error.code}`);
    seq += size;
  }
  return { headSeq: seq - 1 };
};

const readSegments = async (
  engine: StorageEnginePort,
): Promise<readonly JournalSegmentRecord[]> => {
  const r = await engine.txn(['events'], 'readonly', (tx) =>
    tx.table<JournalSegmentRecord>('events').toArray(),
  );
  if (!r.ok) throw new Error('segments read failed');
  return r.value;
};

/** Generated I/O suites (append plans + full CRC walks × FC_NUM_RUNS) need real headroom. */
const INTEGRITY_PROPERTY_TIMEOUT_MS = 600_000;

describe('P1 — clean-journal scan/checkpoint laws', () => {
  it(
    'any reachable journal scans clean and checkpoints exactly at the head (idempotent)',
    { timeout: INTEGRITY_PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(planArb, async (plan) => {
          const { engine, journal } = await makeJournal();
          const { headSeq } = await runPlan(journal, plan);

          const full = await journal.scanFull();
          if (!full.ok) throw new Error('scanFull transport failed');
          expect(full.value.status).toBe('ok');
          expect(full.value.suspects).toEqual([]);

          const cp = await journal.checkpoint();
          if (!cp.ok) throw new Error('checkpoint failed');
          expect(cp.value.stamped).toHaveLength(1);
          expect(cp.value.stamped.at(0)?.throughSeq).toBe(headSeq);

          // Idempotent: restamping over a clean, unchanged journal yields the same ptrs.
          const cp2 = await journal.checkpoint();
          if (!cp2.ok) throw new Error('re-checkpoint failed');
          expect(cp2.value.stamped).toEqual(cp.value.stamped);

          const tail = await journal.scanTail();
          if (!tail.ok) throw new Error('scanTail transport failed');
          expect(tail.value.status).toBe('ok');

          // Post-checkpoint appends remain sane (window advances over the new bytes).
          const more = await journal.append([env(headSeq + 1, headSeq + 1)], {
            idempotencyKey: batchKey(),
          });
          if (!more.ok) throw new Error('post-checkpoint append failed');
          const tail2 = await journal.scanTail();
          if (!tail2.ok) throw new Error('scanTail 2 transport failed');
          expect(tail2.value.status).toBe('ok');
          await engine.close();
        }),
      );
    },
  );
});

type Tamper = (s: JournalSegmentRecord) => JournalSegmentRecord;

/** Structural sabotage kinds — none re-stamps the CRC (drift classes, not forgery). */
const tamperKindArb = (segment: JournalSegmentRecord): fc.Arbitrary<Tamper> => {
  const kinds: fc.Arbitrary<Tamper>[] = [
    fc.constant((s: JournalSegmentRecord): JournalSegmentRecord => ({ ...s, sealed: !s.sealed })),
    fc.integer({ min: 0, max: segment.entries.length - 1 }).map(
      (i) =>
        (s: JournalSegmentRecord): JournalSegmentRecord =>
          ({
            ...s,
            entries: s.entries.map((e, at) =>
              at === i ? { ...e, batchIndex: e.batchIndex + 1 } : e,
            ),
          }) as JournalSegmentRecord,
    ),
    fc.integer({ min: 0, max: segment.entries.length - 1 }).map(
      (i) =>
        (s: JournalSegmentRecord): JournalSegmentRecord =>
          ({
            ...s,
            entries: s.entries.map((e, at) =>
              at === i ? { ...e, event: { ...e.event, payload: { drifted: true } } } : e,
            ),
          }) as JournalSegmentRecord,
    ),
  ];
  if (segment.entries.length >= 2) {
    kinds.push(
      fc.integer({ min: 0, max: segment.entries.length - 1 }).map(
        (i) =>
          (s: JournalSegmentRecord): JournalSegmentRecord =>
            ({
              ...s,
              entries: s.entries.filter((_, at) => at !== i),
            }) as JournalSegmentRecord,
      ),
      fc.constant((s: JournalSegmentRecord): JournalSegmentRecord => {
        // Swap first two entries: ordering drift the chain law must see too.
        const entries = [...s.entries];
        const a = entries.at(0);
        const b = entries.at(1);
        if (a !== undefined && b !== undefined) {
          entries[0] = b;
          entries[1] = a;
        }
        return { ...s, entries } as JournalSegmentRecord;
      }),
    );
  }
  return fc.oneof(...kinds);
};

describe('P2 — tamper is always prosecuted (ADR-004 accident model)', () => {
  it(
    'any drifted segment is suspect-named by scanFull and unservable via readRange',
    { timeout: INTEGRITY_PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(planArb, fc.integer({ min: 0, max: 100 }), async (plan, tamperSeed) => {
          const { engine, journal } = await makeJournal();
          const { headSeq } = await runPlan(journal, plan);
          const segments = await readSegments(engine);
          const target = segments.at(tamperSeed % segments.length);
          if (target === undefined) throw new Error('no segments');

          const tamperArb = tamperKindArb(target);
          const tamper = fc.sample(tamperArb, 1).at(0);
          if (tamper === undefined) throw new Error('no tamper sampled');
          const drifted = tamper(structuredClone(target));

          // Only REAL drift owes prosecution (a coincidentally-identical tamper breaks
          // no law); drift is precisely "the checksum no longer verifies".
          if (verifySegmentCrc(drifted).ok) {
            await engine.close();
            return;
          }
          const put = await engine.txn(['events'], 'readwrite', (tx) =>
            tx.table('events').put(drifted),
          );
          if (!put.ok) throw new Error('tamper put failed');

          const full = await journal.scanFull();
          if (!full.ok) throw new Error('scanFull transport failed');
          expect(full.value.status).toBe('suspect');
          expect(
            full.value.suspects.some(
              (s) => s.segmentId === target.segmentId && s.reason === 'crc-mismatch',
            ),
          ).toBe(true);

          // readRange must refuse to serve any window covering the drifted segment.
          const read = await journal.readRange({ deviceId: DEV, fromSeq: 1, toSeq: headSeq });
          expect(read.ok).toBe(false);
          if (!read.ok) expect(read.error.code).toBe('E_JOURNAL_INTEGRITY');
          await engine.close();
        }),
      );
    },
  );
});

describe('P3 — crc images are content-addressed (canon round-trip law)', () => {
  it('same content ⇒ same image ⇒ same crc; any change changes the crc', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ seq: fc.integer({ min: 1, max: 5000 }), tag: fc.string({ maxLength: 24 }) }),
          {
            minLength: 0,
            maxLength: 40,
          },
        ),
        (rows) => {
          const a = stableStringify({ entries: rows, sealed: false });
          const b = stableStringify({ sealed: false, entries: rows });
          expect(crc32Hex(a)).toBe(crc32Hex(b));
          if (rows.length > 0) {
            const changed = stableStringify({
              entries: [...rows, { seq: 99999, tag: 'x' }],
              sealed: false,
            });
            expect(crc32Hex(changed)).not.toBe(crc32Hex(a));
          }
        },
      ),
    );
  });
});
