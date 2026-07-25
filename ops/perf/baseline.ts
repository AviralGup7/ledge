// E7-T02 · Baseline persistence + regression comparison (mission law: "Store
// benchmark baselines. Future runs must compare against baseline. Fail CI only on
// meaningful regressions. Avoid flaky thresholds.").
//
// R-10 refinement (docs/adr-notes note): the roadmap's flat ">10% any-metric delta"
// is flaky on virtualized CI wall-clock, so a MEANINGFUL regression is a relative
// blow-out AND an absolute one:
//   latency    — worse when newMedian > max(baseline × factor, baseline + slack-ms)
//   throughput — worse when newRate < baseline × factor
//   memory     — worse when newMean > max(baseline × factor, baseline + slack-MB)
// The latency statistic is the MEDIAN on purpose (schema v2, measured): at the CI
// sample count p95 ≈ max, and max jitter on shared runners measured 3× between
// identical-code runs — a threshold riding it fails the mission's anti-flake law.
// Doc budgets (EES §7.1) are asserted separately with their literal numbers — those
// gates sit 10–100× under the budgets, so they are honest, not flaky.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BaselineFile,
  ComparisonRow,
  HostInfo,
  PerfReport,
  ScenarioResult,
  Verdict,
} from './types.js';
import { REPORT_SCHEMA_V } from './types.js';
import type { PerfConfig } from './config.js';

/** Stable artifact formatting (data, not configuration). */
const JSON_INDENT = 2;
const FIXED_DECIMALS = 3;

export const BASELINE_PATH = 'ops/tests/perf/baselines/perf-baseline.v2.json';

const PERCENT = 100;

/** The one comparison statistic per kind (median latency — median-by-law above;
 *  mean throughput and mean MB, both already aggregation-robust). */
export const compareStatisticOf = (row: ScenarioResult): number => {
  if (row.kind === 'latency') return row.stats.median;
  return row.stats.mean;
};

export const loadBaseline = (path: string = BASELINE_PATH): BaselineFile | null => {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    if (parsed.schemaV !== REPORT_SCHEMA_V) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveBaseline = (
  results: readonly ScenarioResult[],
  host: HostInfo,
  path: string = BASELINE_PATH,
): void => {
  const scenarios: Record<string, number> = {};
  for (const row of results) {
    if (row.budget !== undefined) continue; // budget rows compare against law, not history
    scenarios[row.key] = compareStatisticOf(row);
  }
  const file: BaselineFile = {
    schemaV: REPORT_SCHEMA_V,
    recordedAt: new Date().toISOString(),
    host,
    scenarios,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, JSON_INDENT)}\n`, 'utf8');
};

export interface CompareOutcome {
  readonly rows: readonly ComparisonRow[];
  readonly regressionCount: number;
}

const judge = (
  kind: ScenarioResult['kind'],
  baseline: number,
  current: number,
  cfg: PerfConfig['regression'],
): { readonly verdict: Verdict; readonly reason?: string } => {
  if (kind === 'throughput') {
    const floor = baseline * cfg.throughputFactor;
    return current < floor
      ? {
          verdict: 'regressed',
          reason: `throughput ${current} < baseline ${baseline} × ${cfg.throughputFactor}`,
        }
      : { verdict: 'pass' };
  }
  if (kind === 'memory') {
    const ceiling = Math.max(baseline * cfg.memoryFactor, baseline + cfg.memorySlackMb);
    return current > ceiling
      ? {
          verdict: 'regressed',
          reason: `memory ${current}MB > max(baseline ${baseline}MB × ${cfg.memoryFactor}, +${cfg.memorySlackMb}MB)`,
        }
      : { verdict: 'pass' };
  }
  const ceiling = Math.max(baseline * cfg.latencyFactor, baseline + cfg.latencySlackMs);
  return current > ceiling
    ? {
        verdict: 'regressed',
        reason: `median ${current}ms > max(baseline ${baseline}ms × ${cfg.latencyFactor}, +${cfg.latencySlackMs}ms)`,
      }
    : { verdict: 'pass' };
};

/** Compare current results against the recorded baseline (history contract). */
export const compareAgainstBaseline = (
  results: readonly ScenarioResult[],
  baseline: BaselineFile | null,
  cfg: PerfConfig['regression'],
): CompareOutcome => {
  const rows: ComparisonRow[] = [];
  let regressionCount = 0;
  for (const row of results) {
    if (row.budget !== undefined) continue; // law-gated rows are judged by budgets
    const current = compareStatisticOf(row);
    const base = baseline?.scenarios[row.key];
    if (base === undefined) {
      rows.push({
        key: row.key,
        verdict: 'baseline-absent',
        baselineStat: 0,
        currentStat: current,
        deltaPct: 0,
        ...(baseline === null ? { reason: 'no baseline file recorded yet' } : {}),
      });
      continue;
    }
    const { verdict, reason } = judge(row.kind, base, current, cfg);
    if (verdict === 'regressed') regressionCount += 1;
    rows.push({
      key: row.key,
      verdict,
      baselineStat: base,
      currentStat: current,
      deltaPct: base === 0 ? 0 : Math.round(((current - base) / base) * PERCENT),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return { rows, regressionCount };
};

export interface BudgetVerdicts {
  /** Breaches on M1-exit rows (HARD — the lane fails). */
  readonly hardBreaches: readonly string[];
  /** Breaches on reference-profile rows (evidence for E8-T15 hardening; non-fatal). */
  readonly observations: readonly string[];
}

const rowNameOf = (row: ScenarioResult): string =>
  (row.key.split('/')[1] ?? '').split('/')[0] ?? '';

/** Doc-budget gate: hard rows fail the suite; every breach is reported either way. */
export const budgetVerdictsOf = (
  results: readonly ScenarioResult[],
  hardRows: readonly string[],
): BudgetVerdicts => {
  const hardBreaches: string[] = [];
  const observations: string[] = [];
  for (const row of results) {
    if (row.budget === undefined) continue;
    const stat = row.kind === 'throughput' ? row.stats.mean : row.stats.p95;
    if (row.kind === 'throughput' ? stat < row.budget : stat > row.budget) {
      const line = `${row.key}: ${stat.toFixed(FIXED_DECIMALS)} ${row.unit} vs budget ${row.budget} (${row.unit})`;
      if (hardRows.includes(rowNameOf(row))) hardBreaches.push(line);
      else observations.push(line);
    }
  }
  return { hardBreaches, observations };
};

/** Attach comparison rows to the report payload (immutable assembly). */
export const withComparisons = (
  report: Omit<PerfReport, 'comparisons'>,
  comparisons: readonly ComparisonRow[],
): PerfReport => ({ ...report, comparisons });
