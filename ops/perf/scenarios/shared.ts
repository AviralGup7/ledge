// E7-T02 · Shared scenario utilities — row factories + assertion helpers every
// scenario module builds on. Fail-loud law: a perf measurement that silently degraded
// is worse than no measurement, so every Result crossing is unwrapped with a throw.
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
/** Seeding batch size (bigger than the measured append-batch row; law-safe since
 *  SEGMENT_ENTRY_CAP packing is batch-atomic — the journal handles any size). */
const SEED_BATCH = 500;
import { createPrng, type Prng } from '../prng.js';
import { summarize } from '../stats.js';
import type { BackendName, ScenarioResult } from '../types.js';

export const must = <T>(r: Result<T, LedgeError>, where: string): T => {
  if (!r.ok) {
    throw new Error(
      `perf scenario: ${where} → ${r.error.code} ${JSON.stringify(r.error.details ?? {})}`,
    );
  }
  return r.value;
};

const MS_PER_SECOND = 1000;

export const latencyRow = (
  backend: BackendName,
  family: string,
  name: string,
  scale: number,
  samples: readonly number[],
  budget?: number,
): ScenarioResult => ({
  key: `${backend}/${family}.${name}/${scale}`,
  backend,
  family,
  scale,
  kind: 'latency',
  unit: 'ms',
  stats: summarize(samples),
  ...(budget !== undefined ? { budget } : {}),
});

export const throughputRow = (
  backend: BackendName,
  family: string,
  name: string,
  scale: number,
  rates: readonly number[],
): ScenarioResult => ({
  key: `${backend}/${family}.${name}/${scale}`,
  backend,
  family,
  scale,
  kind: 'throughput',
  unit: 'events/s',
  stats: summarize(rates),
});

export const memoryRow = (
  backend: BackendName,
  family: string,
  name: string,
  scale: number,
  mbSamples: readonly number[],
): ScenarioResult => ({
  key: `${backend}/${family}.${name}/${scale}`,
  backend,
  family,
  scale,
  kind: 'memory',
  unit: 'MB',
  stats: summarize(mbSamples),
});

/** events-per-second from (events, elapsed-ms). */
export const rateOf = (events: number, ms: number): number =>
  (events / Math.max(ms, Number.EPSILON)) * MS_PER_SECOND;

/** Append a corpus in fixed-size batches with deterministic idempotency keys. */
export const appendCorpus = async (
  journal: JournalPort,
  corpus: readonly EventEnvelope[],
  keyPrefix = 'perf-corpus',
  batchSize = SEED_BATCH,
): Promise<void> => {
  for (let i = 0; i < corpus.length; i += batchSize) {
    const batch = corpus.slice(i, i + batchSize);
    must(await journal.append(batch, { idempotencyKey: `${keyPrefix}-${i}` }), 'append');
  }
};

export const prngFor = (seed: number): Prng => createPrng(seed);

/** Post-warmup measured runs the floor guarantees (see runsFor). */
const MIN_MEASURED_AFTER_WARMUP = 2;

/**
 * Iteration budget: repeated measurements must cost bounded TOTAL work, so a
 * 50k-scale scenario runs fewer full sweeps than a 100-scale one. Statistics
 * stay meaningful (≥2 runs) while nightly wall-time stays CI-feasible.
 */
/**
 * Iteration budget: repeated measurements must cost bounded TOTAL work, so a
 * 50k-scale scenario runs fewer full sweeps than a 100-scale one. Statistics
 * stay meaningful (≥2 measured runs after warmup) while nightly wall-time stays
 * CI-feasible. `configured` is the TOTAL loop count INCLUDING warmup: the floor
 * guarantees measured samples survive the warmup cut.
 */
export const runsFor = (scale: number, configured: number, eventBudget: number): number =>
  Math.max(
    MIN_MEASURED_AFTER_WARMUP,
    Math.min(configured, Math.floor(eventBudget / Math.max(1, scale))),
  );
