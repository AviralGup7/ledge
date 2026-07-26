// E7-T02 · Harness configuration — env-driven, documented in ops/perf/README.md.
// Every knob the mission demands (workloads, journal sizes, event counts, projection
// counts, sample sizes) lands here behind one parse boundary; scenarios never read env.

/** Parse "100,1000,10000" → [100, 1000, 10000]; falls back on any malformed token. */
const parseScales = (raw: string | undefined, fallback: readonly number[]): readonly number[] => {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = raw
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
  return parsed.length > 0 ? parsed : fallback;
};

const parseIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

const parseFloatEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const parseFlag = (raw: string | undefined): boolean => raw === '1' || raw === 'true';

// ── Defaults (named per §2 — these are the harness contract, not magic) ──────────

/** Mission workload grid decades (named per §2; arrays compose identifiers). */
const SCALE_100 = 100;
const SCALE_1K = 1_000;
const SCALE_10K = 10_000;
const SCALE_50K = 50_000;

/**
 * Mission REFERENCE grid (opt in with PERF_GRID=full): the four mission decades
 * on the memory backend and two on the slower dexie reference backend, with the
 * statistics-grade sample count. This profile takes minutes on virtualized CI —
 * it is the reference-hardware profiling configuration, always paired with the
 * PERF_SUITE_TIMEOUT_MS escape hatch (the 60-second house law's only exception).
 */
const FULL_SCALES = [SCALE_100, SCALE_1K, SCALE_10K, SCALE_50K] as const;
const FULL_DEXIE_SCALES = [SCALE_1K, SCALE_10K] as const;
const FULL_SAMPLES = 21;
const FULL_WARMUP = 3;

/**
 * DEFAULT (CI/nightly) profile: every measurement family and every law still
 * runs — two memory decades plus one dexie tier — because the house law is that
 * a single test finishes inside 60 seconds unless an exception is declared.
 * Scaling findings stay honest (per-element growth is decade-relative, not
 * grid-size-dependent); 10k/50k-tier evidence is a PERF_GRID=full profile run,
 * never a CI gate.
 */
const CI_SCALES = [SCALE_100, SCALE_1K] as const;
const CI_DEXIE_SCALES = [SCALE_1K] as const;
const CI_SAMPLES = 7;
const CI_WARMUP = 1;

/**
 * Regression verdicts (roadmap R-10 refined — see the E7-T02 adr-note):
 * a flat 10% wall-clock delta is flaky-noise on virtualized CI, so "meaningful"
 * combines a RELATIVE factor with an ABSOLUTE floor, and each kind rides an
 * aggregation-robust statistic (median latency, mean elsewhere). The floors
 * below are sized from MEASURED run-to-run jitter on this profile, with margin:
 * identical-code runs showed up to ~1.7× median latency wobble and ~+41MB
 * ambient RSS shift; the thresholds sit clearly above both. Doc budgets
 * (EES §7.1) are asserted separately and never ride these tolerances.
 */

/** Latency regression: new median > max(baseline × factor, baseline + slack). */
const REGRESSION_FACTOR_LATENCY = 1.5;
const REGRESSION_SLACK_MS = 4;

/** Throughput regression: new rate < baseline × factor. */
const REGRESSION_FACTOR_THROUGHPUT = 0.6;

/** Memory regression: new mean > max(baseline × factor, baseline + slack MB). */
const REGRESSION_FACTOR_MEMORY = 1.5;
const REGRESSION_SLACK_MB = 32;

/** Superlinear-growth law: per-element cost may grow ≤ 3× per decade of scale. */
const SCALING_ELEMENT_GROWTH_CAP = 3;

// ── EES §7.1/§7.2 doc budgets (asserted as hard gates with wide headroom) ─────────

export const BUDGETS = {
  /** EES §7.1: SW cold wake → hub ready ≤ 200ms p95. */
  wakeP95Ms: 200,
  /** EES §7.1: Park(100 tabs) durable ack ≤ 500ms p95. */
  parkAckP95Ms: 500,
  /** EES §7.1 / §9 journal row: append batch(20) ≤ 5ms p95. */
  appendBatch20P95Ms: 5,
  /** EES §7.1: ingest projection cost ≤ 5ms/event amortized (burst 500). */
  projectionMsPerEvent: 5,
  /** EES §9 journal row + E2-T01 completion law: tail scan ≤ 50ms steady-state. */
  scanTailP95Ms: 50,
  /** EES §7.8: recovery RTO ≤ 5s boot reconcile. */
  recoveryRtoMs: 5_000,
  /** EES §6 SearchRankPort row / roadmap M3 "Find anything": search query
   *  p95 ≤ 100ms @10k-tab corpus. Observation row until E8-T15 hardening. */
  searchQueryP95Ms: 100,
} as const;

/**
 * M1-EXIT hard gates: literal EES budget rows the lane fails on. The two latency
 * rows carry 20–60× measured headroom, so these are laws, never flake sources.
 * All other §7.1-derived rows are reported as budget OBSERVATIONS (measured on
 * this profile; E8-T15 hardens harness-found deltas — roadmap's own plan).
 */
export const HARD_BUDGET_ROWS = [
  'lifecycle.wake',
  'lifecycle.park.ack',
  'maintenance.recovery.duration',
] as const;

/** Mission corpus sizes: tabs per snapshot/park workload. */
export const SNAPSHOT_TAB_COUNT = 100;
/** EES §7.1 ingest burst size for the amortized-ingest budget row. */
export const INGEST_BURST = 500;
/** EES §7.1 append batch size for the batch(20) budget row. */
export const APPEND_BATCH = 20;

export interface PerfConfig {
  readonly scales: readonly number[];
  readonly dexieScales: readonly number[];
  readonly samples: number;
  readonly warmup: number;
  readonly backends: readonly ('memory' | 'dexie')[];
  readonly updateBaseline: boolean;
  readonly reportDir: string;
  readonly regression: {
    readonly latencyFactor: number;
    readonly latencySlackMs: number;
    readonly throughputFactor: number;
    readonly memoryFactor: number;
    readonly memorySlackMb: number;
    readonly elementGrowthCap: number;
  };
}

const DEFAULT_REPORT_DIR = 'ops/perf/out';

/** Read the environment once; the whole suite consumes this immutable shape. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): PerfConfig => {
  const full = env['PERF_GRID'] === 'full';
  const backends: ('memory' | 'dexie')[] =
    env['PERF_BACKENDS'] === 'memory'
      ? ['memory']
      : env['PERF_BACKENDS'] === 'dexie'
        ? ['dexie']
        : ['memory', 'dexie'];
  return {
    scales: parseScales(env['PERF_SCALES'], full ? FULL_SCALES : CI_SCALES),
    dexieScales: parseScales(env['PERF_DEXIE_SCALES'], full ? FULL_DEXIE_SCALES : CI_DEXIE_SCALES),
    samples: parseIntEnv(env['PERF_SAMPLES'], full ? FULL_SAMPLES : CI_SAMPLES),
    warmup: parseIntEnv(env['PERF_WARMUP'], full ? FULL_WARMUP : CI_WARMUP),
    backends,
    updateBaseline: parseFlag(env['PERF_UPDATE_BASELINE']),
    reportDir: env['PERF_REPORT_DIR'] ?? DEFAULT_REPORT_DIR,
    regression: {
      latencyFactor: parseFloatEnv(env['PERF_REGR_LATENCY_FACTOR'], REGRESSION_FACTOR_LATENCY),
      latencySlackMs: parseFloatEnv(env['PERF_REGR_LATENCY_SLACK_MS'], REGRESSION_SLACK_MS),
      throughputFactor: parseFloatEnv(
        env['PERF_REGR_THROUGHPUT_FACTOR'],
        REGRESSION_FACTOR_THROUGHPUT,
      ),
      memoryFactor: parseFloatEnv(env['PERF_REGR_MEMORY_FACTOR'], REGRESSION_FACTOR_MEMORY),
      memorySlackMb: parseFloatEnv(env['PERF_REGR_MEMORY_SLACK_MB'], REGRESSION_SLACK_MB),
      elementGrowthCap: parseFloatEnv(env['PERF_SCALING_GROWTH_CAP'], SCALING_ELEMENT_GROWTH_CAP),
    },
  };
};
