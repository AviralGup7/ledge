// E2-T11 · compaction + purge exclusion unit suite — the L1..L7 law table of
// compact/types.ts as executable law (ADR-004 collapse honoring purge law;
// ADR-020 physical rewrite with exclusion; EES §4 TrashPurged; Blueprint §14.3
// epochs; roadmap R-02 "purge ⇒ bytes absent" + epoch design).
import { describe, expect, it } from 'vitest';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, DEV_B, makeEnv, makeJournal, testId, openEngine } from '../core/testkit.js';
import type { CompactionBaseline, JournalEntryRecord } from '../core/types.js';
import {
  CHUNK_SEGMENTS_DEFAULT,
  EMPTY_EXCLUDED_DIGEST,
  EXCLUDED_SAMPLE_CAP,
  digestOfExcludedIds,
  digestOfPlan,
  excludeEntries,
  foldExcludedInto,
  payloadMatchesId,
  windowSegments,
} from './policy.js';
import {
  applyCompactChunks,
  applyCompactThroughFlip,
  chainFor,
  makePlan,
  missionIdForSeq,
  readBaseline,
  readSegments,
  seedCompactWorld,
  seedTrashSegmentWorld,
  snapWorld,
  withTxnCount,
} from './testkit.js';
import { META_PURGE_EPOCH_KEY } from '../core/types.js';

const unwrap = <T>(r: Result<T, LedgeError>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
  return r.value;
};

/** Error probe: errors are values — assert code + flat detail row, never throws. */
const expectErr = (r: Result<unknown, LedgeError>, raw: string): void => {
  if (r.ok) throw new Error(`expected ${raw}, got ok`);
  expect(r.error.code).toBe('E_JOURNAL_INTEGRITY');
  expect(r.error.details?.['raw']).toBe(raw);
};

const atIndex = <T>(arr: readonly T[], i: number): T => {
  const v = arr[i];
  if (v === undefined) throw new Error(`harness index ${i} out of bounds (len ${arr.length})`);
  return v;
};

// World geometry (canonical world): 3 sealed segments [1..500][501..1000]
// [1001..1500] + open tail [1501..1517]; horizon 1000 ⇒ window = segments 1,2.
const HEAD_SEQ = 1517;
const TAIL_SEQ_START = 1501;
const SEG2_SEQ_START = 501;
const TRASH_MISSION_ID = '0TRASHED000000000000000000';

describe('E2-T11 policy — subject match + exclusion projection (pure laws)', () => {
  it('L2 match is whole-value equality at any depth, arrays and nesting included', () => {
    const id = 'ID-EXACT';
    expect(payloadMatchesId({ missionId: id }, id)).toBe(true);
    expect(payloadMatchesId({ outer: { inner: { ref: id } } }, id)).toBe(true);
    expect(payloadMatchesId({ refs: ['a', id, 'b'] }, id)).toBe(true);
    expect(payloadMatchesId({ refs: [{ deep: [id] }] }, id)).toBe(true);
  });

  it('L2 match is never substring, never case-folded, never cross-type', () => {
    const id = 'ID-EXACT';
    expect(payloadMatchesId({ note: `xx${id}xx` }, id)).toBe(false);
    expect(payloadMatchesId({ missionId: id.toLowerCase() }, id)).toBe(false);
    expect(payloadMatchesId({ missionId: 42 }, '42')).toBe(false);
    expect(payloadMatchesId(null, id)).toBe(false);
    expect(payloadMatchesId(undefined, id)).toBe(false);
  });

  it('L2 match is depth-capped (defensive bound — deep smuggling is no reference)', () => {
    const id = 'ID-BURIED';
    let nested: unknown = id;
    for (let d = 0; d < 10; d += 1) nested = { layer: nested };
    expect(payloadMatchesId(nested, id)).toBe(false);
    let shallow: unknown = id;
    for (let d = 0; d < 4; d += 1) shallow = { layer: shallow };
    expect(payloadMatchesId(shallow, id)).toBe(true);
  });

  it('L2/L4 projection drops only horizon-eligible matches; survivors keep exact records', () => {
    const horizon = 10;
    const chains = [chainFor('ID-A'), chainFor('ID-B')];
    const eventA = makeEnv(1, 1); // payload missionId testId(9001)
    const entries: JournalEntryRecord[] = [
      { seq: 5, batchIndex: 4, v: 1, event: { ...eventA, payload: { missionId: 'ID-A' } } },
      { seq: 9, batchIndex: 8, v: 1, event: { ...eventA, payload: { missionId: 'ID-B' } } },
      { seq: 11, batchIndex: 10, v: 1, event: { ...eventA, payload: { missionId: 'ID-A' } } },
      { seq: 12, batchIndex: 11, v: 1, event: { ...eventA, payload: { missionId: 'ID-CLEAN' } } },
    ];
    const { kept, excluded } = excludeEntries(entries, horizon, chains);
    // seq 5+9 matched within horizon ⇒ dropped; seq 11 matched but ABOVE ⇒ kept;
    // seq 12 unmatched ⇒ kept. Kept records are the ORIGINAL entry objects.
    expect(kept).toEqual([atIndex(entries, 2), atIndex(entries, 3)]);
    expect(excluded).toEqual([
      { seq: 5, batchIndex: 4, eventId: testId(1), chainKind: 'Mission', chainId: 'ID-A' },
      { seq: 9, batchIndex: 8, eventId: testId(1), chainKind: 'Mission', chainId: 'ID-B' },
    ]);
    expect(kept.length + excluded.length).toBe(entries.length);
  });

  it('L5 plan digest is chain-order-insensitive and horizon/id-sensitive', () => {
    const a = makePlan({ purgeChains: [chainFor('ID-1'), chainFor('ID-2')] });
    const b = makePlan({ purgeChains: [chainFor('ID-2'), chainFor('ID-1')] });
    expect(digestOfPlan(b)).toBe(digestOfPlan(a));
    expect(digestOfPlan(makePlan({ throughSeq: 999 }))).not.toBe(digestOfPlan(a));
    expect(digestOfPlan(makePlan({ purgeChains: [chainFor('ID-3')] }))).not.toBe(digestOfPlan(a));
  });

  it('L5/L7 exclusion digest is commutative — split folds equal whole folds (resume law)', () => {
    const ids = [testId(7), testId(123), testId(500), testId(600)];
    const whole = digestOfExcludedIds(ids);
    expect(
      foldExcludedInto(foldExcludedInto(EMPTY_EXCLUDED_DIGEST, ids.slice(0, 3)), ids.slice(3)),
    ).toBe(whole);
    expect(digestOfExcludedIds([...ids].reverse())).toBe(whole);
    expect(digestOfExcludedIds([])).toBe(EMPTY_EXCLUDED_DIGEST);
  });
});

describe('E2-T11 policy — window law (pure)', () => {
  it('L1/L4 window is device-scoped, sealed-only, horizon-bounded, stream-ordered', async () => {
    const { engine } = await makeJournal();
    await seedCompactWorld(engine);
    const segments = await readSegments(engine);
    expect(segments).toHaveLength(4);

    const full = windowSegments(segments, DEV_A as string, HEAD_SEQ - 1);
    // The OPEN tail is never in window, even when the horizon reaches into it.
    expect(full.map((s) => s.seqStart)).toEqual([1, SEG2_SEQ_START, 1001]);
    expect(full.every((s) => s.sealed)).toBe(true);

    const partial = windowSegments(segments, DEV_A as string, 250);
    expect(partial.map((s) => s.seqStart)).toEqual([1]);

    const otherDevice = windowSegments(segments, DEV_B as string, HEAD_SEQ - 1);
    expect(otherDevice).toEqual([]);
    await engine.close();
  });
});

describe('E2-T11 compactor — guards (prosecution, never repair)', () => {
  it('L1 horizon must close strictly below the device head', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    expectErr(
      await journal.compact(makePlan({ throughSeq: HEAD_SEQ })),
      'compaction-horizon-invalid',
    );
    expectErr(
      await journal.compact(makePlan({ throughSeq: HEAD_SEQ + 500 })),
      'compaction-horizon-invalid',
    );
    await engine.close();
  });

  it('L1 a device with no stream has no lawful horizon', async () => {
    const { engine, journal } = await makeJournal();
    expectErr(await journal.compact(makePlan()), 'compaction-horizon-invalid');
    await engine.close();
  });

  it('L2 a plan without purge chains is refused', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    expectErr(await journal.compact(makePlan({ purgeChains: [] })), 'compaction-plan-empty');
    await engine.close();
  });

  it('L5 an unknown baseline schema version is prosecuted, never migrated in place', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const foreign = { schemaV: 2, status: 'done' } as unknown as CompactionBaseline;
    unwrap(
      await engine.txn(['meta'], 'readwrite', (tx) =>
        tx.table('meta').put({ key: META_PURGE_EPOCH_KEY, value: { [DEV_A as string]: foreign } }),
      ),
      'foreign baseline seed',
    );
    expectErr(await journal.compact(makePlan()), 'compaction-baseline-unknown');
    await engine.close();
  });
});

describe('E2-T11 compactor — the sweep (L1..L7 end-to-end)', () => {
  /** Canonical happy-path plan: 4 effective targets + 1 absent + 1 above-horizon. */
  const happyPlan = () =>
    makePlan({
      throughSeq: 1000,
      purgeChains: [
        chainFor(missionIdForSeq(7)),
        chainFor(missionIdForSeq(123)),
        chainFor(missionIdForSeq(500)),
        chainFor(missionIdForSeq(600)),
        chainFor(missionIdForSeq(9999)), // absent — no payload anywhere
        chainFor(missionIdForSeq(1200)), // present but ABOVE the horizon (L4 keeps it)
      ],
    });

  it('excludes exactly the horizon-eligible matches, survivors byte-identical, tail frozen', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const preRange = unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'pre');
    const preTail = (await readSegments(engine)).find((s) => s.seqStart === TAIL_SEQ_START);

    const excludedSeqs = new Set([7, 123, 500, 600]);
    const report = unwrap(await journal.compact(happyPlan()), 'compact');

    expect(report.noOp).toBe(false);
    expect(report.resumed).toBe(false);
    expect(report.epoch).toBe(1);
    expect(report.entriesExcluded).toBe(excludedSeqs.size);
    expect(report.segmentsInWindow).toBe(2);
    expect(report.segmentsRewritten).toBe(2);
    expect(report.segmentsDeleted).toBe(0);
    // Audit sample: full precision, stream order, exact batch indexes.
    expect(report.excludedSample).toEqual([
      {
        seq: 7,
        batchIndex: 6,
        eventId: testId(7),
        chainKind: 'Mission',
        chainId: missionIdForSeq(7),
      },
      {
        seq: 123,
        batchIndex: 122,
        eventId: testId(123),
        chainKind: 'Mission',
        chainId: missionIdForSeq(123),
      },
      {
        seq: 500,
        batchIndex: 499,
        eventId: testId(500),
        chainKind: 'Mission',
        chainId: missionIdForSeq(500),
      },
      {
        seq: 600,
        batchIndex: 99,
        eventId: testId(600),
        chainKind: 'Mission',
        chainId: missionIdForSeq(600),
      },
    ]);
    expect(report.excludedDigest).toBe(
      digestOfExcludedIds([testId(7), testId(123), testId(500), testId(600)]),
    );

    // P1 (roadmap criterion): purged bytes absent from the served stream; P2:
    // every survivor is byte-identical to its pre-compaction record.
    const postRange = unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'post');
    const expected = preRange.events.filter((e) => !excludedSeqs.has(e.seq));
    expect(stableStringify(postRange.events)).toBe(stableStringify(expected));
    expect(postRange.events.some((e) => excludedSeqs.has(e.seq))).toBe(false);
    // Above-horizon match survived (L4), open tail untouched.
    expect(postRange.events.some((e) => e.seq === 1200)).toBe(true);
    const postTail = (await readSegments(engine)).find((s) => s.seqStart === TAIL_SEQ_START);
    expect(stableStringify(postTail)).toBe(stableStringify(preTail));

    // Scan/checkpoint laws hold over the compacted bytes (baseline explains gaps).
    expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
    const stamp = report.checkpoints.find((c) => (c.deviceId as string) === (DEV_A as string));
    expect(stamp?.throughSeq).toBe(HEAD_SEQ);
    expect(stamp?.lastSegmentId).toBe(`${DEV_A as string}:${TAIL_SEQ_START}`);
    expect(stamp?.crc).toBe(postTail?.crc ?? 'missing');

    // Baseline row: done, epoch 1, exact totals (port state == storage row).
    const baseline = unwrap(await journal.compactionState(DEV_A), 'state');
    expect(baseline).toEqual({
      schemaV: 1,
      deviceId: DEV_A,
      status: 'done',
      epoch: 1,
      throughSeq: 1000,
      planDigest: digestOfPlan(happyPlan()),
      cursorSeqStart: null,
      entriesExcluded: excludedSeqs.size,
      excludedDigest: report.excludedDigest,
    });
    expect(await readBaseline(engine)).toEqual(baseline);
    await engine.close();
  });

  it('regression (fc seeds -1837396675 / 350748120): horizon at/inside the open tail — sealed matches fall, open-tail matches survive', async () => {
    // Property-suite counterexamples: chains mixed across the sealed/open
    // boundary, the horizon at or inside the tail. Jurisdiction stays sealed-only.
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine); // sealed [1..1500], open [1501..1517]
    const report = unwrap(
      await journal.compact(
        makePlan({
          throughSeq: TAIL_SEQ_START, // horizon EXACTLY at the first open-tail entry
          purgeChains: [
            chainFor(missionIdForSeq(7)), // sealed
            chainFor(missionIdForSeq(TAIL_SEQ_START)), // first entry of the open tail
            chainFor(missionIdForSeq(1505)), // open tail
          ],
        }),
      ),
      'compact',
    );
    expect(report.entriesExcluded).toBe(1);
    expect(report.excludedSample.map((m) => m.seq)).toEqual([7]);
    const post = unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'post');
    expect(post.events.some((e) => e.seq === 7)).toBe(false);
    expect(post.events.some((e) => e.seq === TAIL_SEQ_START || e.seq === 1505)).toBe(true);
    expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
    await engine.close();
  });

  it('L3 a fully-excluded segment is physically DELETED — bytes gone, not masked', async () => {
    // Property-suite counterexample: chains mixed across the sealed/open
    // boundary with the horizon inside the tail. Jurisdiction stays sealed-only.
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine); // sealed [1..1500], open [1501..1517]
    const report = unwrap(
      await journal.compact(
        makePlan({
          throughSeq: 1502,
          purgeChains: [
            chainFor(missionIdForSeq(7)), // sealed
            chainFor(missionIdForSeq(1501)), // first entry of the open tail
            chainFor(missionIdForSeq(1505)), // open tail
          ],
        }),
      ),
      'compact',
    );
    expect(report.entriesExcluded).toBe(1);
    expect(report.excludedSample.map((m) => m.seq)).toEqual([7]);
    const post = unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'post');
    expect(post.events.some((e) => e.seq === 7)).toBe(false);
    expect(post.events.some((e) => e.seq === 1501 || e.seq === 1505)).toBe(true);
    expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
    await engine.close();
  });

  it('L3 a fully-excluded segment is physically DELETED — bytes gone, not masked', async () => {
    const { engine, journal } = await makeJournal();
    await seedTrashSegmentWorld(engine, TRASH_MISSION_ID);
    const report = unwrap(
      await journal.compact(
        makePlan({ throughSeq: 500, purgeChains: [chainFor(TRASH_MISSION_ID)] }),
      ),
      'compact',
    );
    expect(report.segmentsDeleted).toBe(1);
    expect(report.segmentsRewritten).toBe(0);
    expect(report.entriesExcluded).toBe(500);

    // Store-level absence: the row is gone from IndexedDB, not merely hidden.
    const row = unwrap(
      await engine.txn(['events'], 'readonly', (tx) =>
        tx.table('events').get(`${DEV_A as string}:1`),
      ),
      'row get',
    );
    expect(row).toBeUndefined();
    expect(await readSegments(engine)).toHaveLength(3);

    // The served stream starts at seq 501; scanner tolerates the purge gap
    // (baseline L6); checkpoint restamps over the remaining bytes.
    const post = unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'post');
    expect(atIndex(post.events, 0).seq).toBe(SEG2_SEQ_START);
    expect(post.events).toHaveLength(HEAD_SEQ - 500);
    expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
    expect(unwrap(await journal.scanTail(), 'scanTail').status).toBe('ok');
    unwrap(await journal.checkpoint(), 'checkpoint');
    await engine.close();
  });

  it('L7 sweep is chunked: exactly one events-mutating txn per chunk', async () => {
    const { engine } = await makeJournal();
    await seedCompactWorld(engine);
    const { engine: counted, accounting } = withTxnCount(engine);
    const journal = createJournal(counted);
    const report = unwrap(
      await journal.compact(
        makePlan({
          throughSeq: 1000,
          chunkSegments: 1,
          purgeChains: [chainFor(missionIdForSeq(7)), chainFor(missionIdForSeq(600))],
        }),
      ),
      'compact',
    );
    expect(report.segmentsRewritten).toBe(2);
    expect(accounting.eventsMutatingTxns()).toBe(2);
    expect(accounting.eventsWrites()).toBe(2);
    await engine.close();
  });

  it('audit sample is capped; counts + digest carry the whole story', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const targetSeqs = Array.from({ length: 150 }, (_, i) => i + 1);
    const report = unwrap(
      await journal.compact(
        makePlan({
          throughSeq: 500,
          purgeChains: targetSeqs.map((seq) => chainFor(missionIdForSeq(seq))),
        }),
      ),
      'compact',
    );
    expect(report.entriesExcluded).toBe(150);
    expect(report.excludedSample).toHaveLength(EXCLUDED_SAMPLE_CAP);
    expect(report.excludedDigest).toBe(digestOfExcludedIds(targetSeqs.map((seq) => testId(seq))));
    await engine.close();
  });
});

describe('E2-T11 compactor — no-exclusion close-out (L4/L5 discipline)', () => {
  it('nothing eligible ⇒ true no-op: no baseline row, bytes frozen, checkpoint restamped', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const before = await snapWorld(engine);
    const report = unwrap(
      await journal.compact(makePlan({ purgeChains: [chainFor(missionIdForSeq(9999))] })),
      'compact',
    );
    expect(report.noOp).toBe(true);
    expect(report.entriesExcluded).toBe(0);
    expect(await readBaseline(engine)).toBeNull();
    expect(unwrap(await journal.compactionState(DEV_A), 'state')).toBeNull();
    expect(await snapWorld(engine)).toBe(before);
    await engine.close();
  });

  it('L1/L4 a match living ONLY in the open tail is never touched', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const before = await snapWorld(engine);
    const report = unwrap(
      await journal.compact(
        makePlan({ throughSeq: HEAD_SEQ - 1, purgeChains: [chainFor(missionIdForSeq(1505))] }),
      ),
      'compact',
    );
    expect(report.noOp).toBe(true);
    expect(report.entriesExcluded).toBe(0);
    expect(await snapWorld(engine)).toBe(before);
    await engine.close();
  });
});

describe('E2-T11 compactor — idempotence, epochs, resume (L5/L7)', () => {
  const plan4 = (chunkSegments = CHUNK_SEGMENTS_DEFAULT) =>
    makePlan({
      throughSeq: 1000,
      chunkSegments,
      purgeChains: [
        chainFor(missionIdForSeq(7)),
        chainFor(missionIdForSeq(123)),
        chainFor(missionIdForSeq(500)),
        chainFor(missionIdForSeq(600)),
      ],
    });

  it('same-plan replay is a byte-frozen no-op carrying the epoch totals', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const first = unwrap(await journal.compact(plan4()), 'first');
    const frozen = await snapWorld(engine);
    const second = unwrap(await journal.compact(plan4()), 'second');
    expect(second.noOp).toBe(true);
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(first.epoch);
    expect(second.entriesExcluded).toBe(first.entriesExcluded);
    expect(second.excludedDigest).toBe(first.excludedDigest);
    expect(await snapWorld(engine)).toBe(frozen);
    await engine.close();
  });

  it('resume after a mid-sweep kill converges to the uninterrupted end state, byte for byte', async () => {
    const plan = plan4(1);
    // World A: killed after chunk 0 of 2 (running baseline mid-window).
    const engineA = await openEngine();
    await seedCompactWorld(engineA);
    await applyCompactChunks(engineA, plan, 1);
    // L6: the in-flight baseline makes the purge gap scan-lawful at the kill image.
    expect(unwrap(await createJournal(engineA).scanFull(), 'scan@torn').status).toBe('ok');
    const reportA = unwrap(await createJournal(engineA).compact(plan), 'resume');
    expect(reportA.resumed).toBe(true);
    expect(reportA.noOp).toBe(false);
    // World B: uninterrupted twin.
    const engineB = await openEngine();
    await seedCompactWorld(engineB);
    const reportB = unwrap(await createJournal(engineB).compact(plan), 'twin');
    expect(reportB.resumed).toBe(false);
    // THE L7 law: byte-identical durable truth (events + meta, idem ledger included).
    expect(await snapWorld(engineA)).toBe(await snapWorld(engineB));
    expect(reportA.entriesExcluded).toBe(reportB.entriesExcluded);
    expect(reportA.excludedDigest).toBe(reportB.excludedDigest);
    await engineA.close();
    await engineB.close();
  });

  it('a racing plan over a running baseline is prosecuted; the owning plan resumes', async () => {
    const engine = await openEngine();
    await seedCompactWorld(engine);
    const journal = createJournal(engine);
    const owner = plan4(1);
    await applyCompactChunks(engine, owner, 1);
    const rival = makePlan({ throughSeq: 900, purgeChains: [chainFor(missionIdForSeq(50))] });
    expectErr(await journal.compact(rival), 'compaction-plan-conflict');
    const resumed = unwrap(await journal.compact(owner), 'resume');
    expect(resumed.resumed).toBe(true);
    expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
    await engine.close();
  });

  it('epochs advance monotonically per device; a horizon regression is refused', async () => {
    const { engine, journal } = await makeJournal();
    await seedCompactWorld(engine);
    const first = unwrap(await journal.compact(plan4()), 'epoch 1');
    expect(first.epoch).toBe(1);
    const secondPlan = makePlan({
      throughSeq: 1200,
      purgeChains: [chainFor(missionIdForSeq(1100))],
    });
    const second = unwrap(await journal.compact(secondPlan), 'epoch 2');
    expect(second.epoch).toBe(2);
    expect(second.entriesExcluded).toBe(1);
    expect(unwrap(await journal.compactionState(DEV_A), 'state')?.epoch).toBe(2);
    // Epoch-1 chains stay excluded (P1 holds cumulatively) and epoch-2's gap is
    // scan-lawful: full history is the single baseline's growing horizon.
    const post = unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'post');
    expect(post.events.some((e) => e.seq === 7 || e.seq === 1100)).toBe(false);
    expect(unwrap(await journal.scanFull(), 'scanFull').status).toBe('ok');
    const regressed = makePlan({ throughSeq: 500, purgeChains: [chainFor(missionIdForSeq(42))] });
    expectErr(await journal.compact(regressed), 'compaction-horizon-regression');
    await engine.close();
  });

  it('kill AFTER the flip but before the checkpoint restamp replays as a restamping no-op', async () => {
    const plan = plan4(1);
    const engineA = await openEngine();
    await seedCompactWorld(engineA);
    await applyCompactThroughFlip(engineA, plan);
    // Torn image: done baseline, no checkpoint over the rewritten bytes.
    expect((await readBaseline(engineA))?.status).toBe('done');
    expect(unwrap(await createJournal(engineA).scanFull(), 'scan@torn').status).toBe('ok');
    const replay = unwrap(await createJournal(engineA).compact(plan), 'replay');
    expect(replay.noOp).toBe(true);
    const stamp = replay.checkpoints.find((c) => (c.deviceId as string) === (DEV_A as string));
    expect(stamp?.throughSeq).toBe(HEAD_SEQ);
    const engineB = await openEngine();
    await seedCompactWorld(engineB);
    unwrap(await createJournal(engineB).compact(plan), 'twin');
    expect(await snapWorld(engineA)).toBe(await snapWorld(engineB));
    await engineA.close();
    await engineB.close();
  });
});
