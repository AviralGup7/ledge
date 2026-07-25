// E7-T02 · Report model — the machine-readable contract of the harness
// (schemaV-stamped; baselines and reports share these shapes).
import type { SampleStats } from './stats.js';

export type BackendName = 'memory' | 'dexie';

export type MetricKind = 'latency' | 'throughput' | 'memory';

export interface ScenarioResult {
  /** Unique stable identity: '<backend>/<family>.<name>[/<scale>]'. */
  readonly key: string;
  readonly backend: BackendName;
  /** Family groups scenario rows (journal, projections, lifecycle, …). */
  readonly family: string;
  /** Corpus size the row was measured at (0 = scale-free). */
  readonly scale: number;
  readonly kind: MetricKind;
  /** 'ms' | 'MB' | 'events/s'. */
  readonly unit: string;
  /** Mission-required distribution: mean, median, P95, P99, min, max, stddev. */
  readonly stats: SampleStats;
  /** Doc-budget gate applied to this row (ms/event scaled budgets pre-multiplied). */
  readonly budget?: number | undefined;
}

export type Verdict = 'pass' | 'regressed' | 'baseline-absent' | 'budget-breach';

export interface ComparisonRow {
  readonly key: string;
  readonly verdict: Verdict;
  readonly baselineStat: number;
  readonly currentStat: number;
  /** Signed percent change of the comparison statistic (median latency / mean rate / mean MB). */
  readonly deltaPct: number;
  readonly reason?: string | undefined;
}

export interface HostInfo {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemMB: number;
}

export interface BaselineFile {
  readonly schemaV: typeof REPORT_SCHEMA_V;
  readonly recordedAt: string;
  readonly host: HostInfo;
  /** key → comparison statistic (median latency · mean throughput · mean MB). */
  readonly scenarios: Readonly<Record<string, number>>;
}

export interface PerfReport {
  readonly schemaV: typeof REPORT_SCHEMA_V;
  readonly recordedAt: string;
  readonly host: HostInfo;
  readonly results: readonly ScenarioResult[];
  readonly comparisons: readonly ComparisonRow[];
  /** Superlinear-growth findings (per-element cost ×/decade beyond the cap). */
  readonly scalingFindings: readonly string[];
  /** HARD budget breaches (M1-exit rows — these fail the lane). */
  readonly budgetBreaches: readonly string[];
  /** Soft budget observations (EES §7.1 reference-profile rows measured on the
   *  dev profile: recorded as evidence — E8-T15 owns harness-delta fixes). */
  readonly budgetObservations: readonly string[];
}

/**
 * Baseline/report schema version — bump invalidates recorded baselines by law
 * (loadBaseline returns null). v1 → v2 (E7-T02 anti-flake refinement, measured):
 * the latency comparison statistic moved from p95 to MEDIAN because at the CI
 * sample count p95 ≈ max, the most noise-sensitive statistic on virtualized CI
 * (3× run-to-run jitter measured on identical code). p95/p99 remain reported
 * and remain the doc-budget statistic; the regression verdict rides the median.
 */
export const REPORT_SCHEMA_V = 2;
