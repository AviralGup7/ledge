// E7-T02 · Journal scenarios — append throughput, batch latency, replay, scans,
// checkpoint over the mission workload grid. EES §9/§7.1 bench rows ride along:
// append batch(20) p95 ≤ 5ms · tail scan ≤ 50ms steady-state.
//
// Iteration economics (CI wall-time law): the APPEND measurement accumulates
// continuations into one journal capped by APPEND_EVENT_BUDGET total events;
// replay/scan/checkpoint run against a SEPARATE journal seeded to exactly
// `scale` events, so their "stream of length scale" claim is literal.
import type { PerfConfig } from '../config.js';
import { BUDGETS, APPEND_BATCH } from '../config.js';
import type { BackendSession } from '../backends.js';
import { makeJournalCorpus, DEV_A } from '../corpora.js';
import {
  appendCorpus,
  latencyRow,
  memoryRow,
  must,
  rateOf,
  runsFor,
  throughputRow,
} from './shared.js';
import { measureMemory } from '../timing.js';
import type { ScenarioResult } from '../types.js';
import { stableStringify, fnv1a64 } from '@/shared-kernel/canon/index.js';

export const FAMILY = 'journal';

const SEED = 7_001;

/** Corpus seed offsets keep sibling measurement phases on disjoint corpora. */
const SWEEP_SEED_OFFSET = 500;
const MEMORY_SEED_OFFSET = 100;

/** Total events the append sweep may pile into one image across all iterations. */
const APPEND_EVENT_BUDGET = 120_000;
/** Full-sweep read operations (replay/scan/checkpoint) cap their iterations too. */
const SWEEP_EVENT_BUDGET = 500_000;
/** Batch-latency samples per measured run (stride sampling at big scales). */
const BATCH_SAMPLE_CAP = 400;

const appendScenario = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const backend = await session.open();
  const runMs: number[] = [];
  const batchMs: number[] = [];
  const iterations = Math.max(
    cfg.warmup + 1,
    runsFor(scale, cfg.samples + cfg.warmup, APPEND_EVENT_BUDGET),
  );
  // Stride sampling: collect ≤ BATCH_SAMPLE_CAP batch-latency samples per run even
  // at the 50k tier (2,500 batches/run would bury the signal in its own cost).
  const batchStride = Math.max(1, Math.floor(scale / APPEND_BATCH / BATCH_SAMPLE_CAP));
  let nextSeq = 1;
  for (let i = 0; i < iterations; i += 1) {
    const run = makeJournalCorpus(scale, SEED + 1 + i, DEV_A).map((e, k) => ({
      ...e,
      hlc: { ...e.hlc, seq: nextSeq + k, lamport: nextSeq + k },
    }));
    nextSeq += run.length;
    const start = performance.now();
    for (let b = 0, nth = 0; b < run.length; b += APPEND_BATCH, nth += 1) {
      const t0 = performance.now();
      must(
        await backend.journal.append(run.slice(b, b + APPEND_BATCH), {
          idempotencyKey: `perf-append-${i}-${b}`,
        }),
        'append',
      );
      if (i >= cfg.warmup && nth % batchStride === 0) batchMs.push(performance.now() - t0);
    }
    if (i >= cfg.warmup) runMs.push(performance.now() - start);
  }
  return [
    throughputRow(
      backend.name,
      FAMILY,
      'append',
      scale,
      runMs.map((ms) => rateOf(scale, ms)),
    ),
    latencyRow(
      backend.name,
      FAMILY,
      'append.batch',
      APPEND_BATCH,
      batchMs,
      BUDGETS.appendBatch20P95Ms,
    ),
  ];
};

const sweepsScenario = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const out: ScenarioResult[] = [];
  const backend = await session.open();
  const corpus = makeJournalCorpus(scale, SEED + SWEEP_SEED_OFFSET, DEV_A);
  await appendCorpus(backend.journal, corpus, `perf-sweep-${scale}`);
  const head = scale;
  const iterations = runsFor(scale, cfg.samples + cfg.warmup, SWEEP_EVENT_BUDGET);

  // ── replay: full readRange scan (also the boot rehydration cost model) ───────
  const replayMs: number[] = [];
  const replayRates: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    const r = must(
      await backend.journal.readRange({ deviceId: DEV_A, fromSeq: 1, toSeq: head }),
      'readRange',
    );
    const ms = performance.now() - t0;
    if (r.events.length !== head) {
      throw new Error(`replay served ${r.events.length}, expected ${head}`);
    }
    if (i >= cfg.warmup) {
      replayMs.push(ms);
      replayRates.push(rateOf(r.events.length, ms));
    }
  }
  out.push(latencyRow(backend.name, FAMILY, 'replay', head, replayMs));
  out.push(throughputRow(backend.name, FAMILY, 'replay', head, replayRates));

  // ── replay determinism evidence: two full replays digest byte-identical ──────
  const digestOf = (
    events: readonly {
      readonly seq: number;
      readonly batchIndex: number;
      readonly envelope: unknown;
    }[],
  ): string => fnv1a64(stableStringify(events.map((e) => [e.seq, e.batchIndex, e.envelope])));
  const first = must(
    await backend.journal.readRange({ deviceId: DEV_A, fromSeq: 1, toSeq: head }),
    'readRange#det-1',
  );
  const second = must(
    await backend.journal.readRange({ deviceId: DEV_A, fromSeq: 1, toSeq: head }),
    'readRange#det-2',
  );
  if (digestOf(first.events) !== digestOf(second.events)) {
    throw new Error('REPLAY-NONDETERMINISM: two readRange scans of one image diverged');
  }

  // ── scan.tail (steady-state law: checkpoint first, then the cheap walk) ──────
  must(await backend.journal.checkpoint(), 'checkpoint#pre-tail');
  const tailMs: number[] = [];
  for (let i = 0; i < cfg.samples + cfg.warmup; i += 1) {
    const t0 = performance.now();
    must(await backend.journal.scanTail(), 'scanTail');
    if (i >= cfg.warmup) tailMs.push(performance.now() - t0);
  }
  out.push(latencyRow(backend.name, FAMILY, 'scan.tail', head, tailMs, BUDGETS.scanTailP95Ms));

  // ── scan.full: CRC-walk every segment (weekly-walk cost model) ───────────────
  const fullMs: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    must(await backend.journal.scanFull(), 'scanFull');
    if (i >= cfg.warmup) fullMs.push(performance.now() - t0);
  }
  out.push(latencyRow(backend.name, FAMILY, 'scan.full', head, fullMs));

  // ── checkpoint latency: full scan + stamp over the live head ─────────────────
  const cpMs: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    must(await backend.journal.checkpoint(), 'checkpoint');
    if (i >= cfg.warmup) cpMs.push(performance.now() - t0);
  }
  out.push(latencyRow(backend.name, FAMILY, 'checkpoint', head, cpMs));

  return out;
};

/** Memory signature of the append workload at this scale (peak + steady-state). */
const memoryScenario = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const peaks: number[] = [];
  const steadies: number[] = [];
  const iterations = runsFor(scale, cfg.samples, APPEND_EVENT_BUDGET);
  for (let i = 0; i < iterations; i += 1) {
    const backend = await session.openFresh();
    const corpus = makeJournalCorpus(scale, SEED + MEMORY_SEED_OFFSET + i, DEV_A);
    const sig = await measureMemory(async (markPeak) => {
      await appendCorpus(backend.journal, corpus, `perf-mem-${i}`);
      markPeak();
    });
    peaks.push(sig.peakMB);
    steadies.push(sig.steadyMB);
  }
  return [
    memoryRow(session.name, FAMILY, 'memory.append.peak', scale, peaks),
    memoryRow(session.name, FAMILY, 'memory.append.steady', scale, steadies),
  ];
};

export const journalScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const append = await appendScenario(session, scale, cfg);
  const sweeps = await sweepsScenario(createSessionFrom(session), scale, cfg);
  const mem = await memoryScenario(createSessionFrom(session), scale, cfg);
  return [...append, ...sweeps, ...mem];
};

// The append phase's image is polluted by iteration accumulation; sweeps and
// memory measurements deserve pristine journals. BackendSession is re-creatable
// from its name (sessions hold no irreplaceable state by design).
import { createBackendSession } from '../backends.js';
const createSessionFrom = (s: BackendSession): BackendSession => createBackendSession(s.name);
