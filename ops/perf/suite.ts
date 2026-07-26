// E7-T02 · Suite orchestrator — runs the configured backend×scale matrix across all
// scenario families, derives scaling findings (nonlinear-growth detection per the
// mission), compares against the recorded baseline, and emits the machine-readable
// report. The vitest lane (ops/tests/perf/harness) is a thin gate over this.
import type { PerfConfig } from './config.js';
import { HARD_BUDGET_ROWS } from './config.js';
import { createBackendSession } from './backends.js';
import {
  compareAgainstBaseline,
  budgetVerdictsOf,
  saveBaseline,
  loadBaseline,
} from './baseline.js';
import { emptyReport, hostInfo, writeReportArtifacts } from './report.js';
import { perfTraceWall } from './timing.js';
import type { BackendName, PerfReport, ScenarioResult } from './types.js';
import { journalScenarios } from './scenarios/journal.js';
import { projectionScenarios } from './scenarios/projections.js';
import { snapshotScenarios } from './scenarios/snapshots.js';
import { lifecycleScenarios } from './scenarios/lifecycle.js';
import { maintenanceScenarios } from './scenarios/maintenance.js';
import { storageScenarios } from './scenarios/storage.js';
import { ingestScenarios } from './scenarios/ingest.js';
import { searchScenarios } from './scenarios/search.js';

/** Finding string precision (display constant). */
const FINDING_DECIMALS = 2;

/** Snapshot workloads scale by tab count; the 50k-tab single-payload tier is a
 *  200k-tier concern (EES §7.9), the mission grid caps snapshot at 10k tabs. */
const SNAPSHOT_TAB_CAP = 10_000;

/** Families without a scaling story (fixed-cost or capped-corporation workloads)
 *  skip the heaviest tiers — the scaling grid is proven on the journal/projection
 *  rows where nonlinear behavior would live. */
const LIFECYCLE_SCALE_CAP = 10_000;
const INGEST_SCALE_CAP = 10_000;

const scalesFor = (name: BackendName, cfg: PerfConfig): readonly number[] =>
  name === 'memory' ? cfg.scales : cfg.dexieScales;

/**
 * PERF_TRACE=1 prints per-family wall-clock to stderr via the sanctioned sink
 * (timing.ts): wall-time tuning under the 60-second house law is a measured
 * discipline, never a blind one.
 */

const runBackend = async (
  name: BackendName,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const out: ScenarioResult[] = [];
  for (const scale of scalesFor(name, cfg)) {
    let t0 = Date.now();
    const session = createBackendSession(name);
    out.push(...(await journalScenarios(session, scale, cfg)));
    perfTraceWall(`${name} journal @${scale}`, t0);
    t0 = Date.now();
    out.push(...(await projectionScenarios(createBackendSession(name), scale, cfg)));
    perfTraceWall(`${name} projections @${scale}`, t0);
    if (scale <= SNAPSHOT_TAB_CAP) {
      t0 = Date.now();
      out.push(...(await snapshotScenarios(createBackendSession(name), scale, cfg)));
      perfTraceWall(`${name} snapshots @${scale}`, t0);
    }
    if (scale <= LIFECYCLE_SCALE_CAP) {
      t0 = Date.now();
      out.push(...(await lifecycleScenarios(createBackendSession(name), scale, cfg)));
      perfTraceWall(`${name} lifecycle @${scale}`, t0);
    }
    t0 = Date.now();
    out.push(...(await maintenanceScenarios(createBackendSession(name), scale, cfg)));
    perfTraceWall(`${name} maintenance @${scale}`, t0);
    t0 = Date.now();
    out.push(...(await storageScenarios(createBackendSession(name), scale, cfg)));
    perfTraceWall(`${name} storage @${scale}`, t0);
    if (scale <= INGEST_SCALE_CAP) {
      t0 = Date.now();
      out.push(...(await ingestScenarios(createBackendSession(name), scale, cfg)));
      perfTraceWall(`${name} ingest @${scale}`, t0);
    }
    t0 = Date.now();
    out.push(...(await searchScenarios(createBackendSession(name), scale, cfg)));
    perfTraceWall(`${name} search @${scale}`, t0);
  }
  return out;
};

/**
 * Nonlinear-growth detection (mission: "Measure scaling. Detect nonlinear
 * behavior.") — per-element cost growth across consecutive scale decades. O(n)
 * keeps the ratio ≈1; log factors add ≤1.5; a ratio beyond the cap is an
 * accidental O(n²) smell worth failing CI over on the deterministic backend.
 * A noise floor skips sub-few-ms rows: per-element ratios of timer quantization
 * are noise, and the detector's job is algorithmic growth, not jitter.
 */
const SCALING_NOISE_FLOOR_MS = 5;

const scalingFindings = (
  results: readonly ScenarioResult[],
  growthCap: number,
): readonly string[] => {
  const findings: string[] = [];
  const byName = new Map<string, ScenarioResult[]>();
  for (const row of results) {
    if (row.backend !== 'memory' || row.kind === 'memory') continue;
    // Key layout '<backend>/<family>.<name>/<scale>' → per-row-name grouping.
    const name = row.key.slice(row.backend.length + 1, row.key.lastIndexOf('/'));
    const list = byName.get(name) ?? [];
    list.push(row);
    byName.set(name, list);
  }
  for (const [name, rows] of byName) {
    const sorted = [...rows].sort((a, b) => a.scale - b.scale);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev === undefined || cur === undefined || prev.scale === 0 || cur.scale === prev.scale)
        continue;
      if (prev.stats.mean < SCALING_NOISE_FLOOR_MS && cur.stats.mean < SCALING_NOISE_FLOOR_MS)
        continue;
      const prevPerElement = prev.stats.mean / prev.scale;
      const curPerElement = cur.stats.mean / cur.scale;
      if (prevPerElement === 0) continue;
      const growth = curPerElement / prevPerElement;
      if (growth > growthCap) {
        findings.push(
          `${name}: per-element cost grew ${growth.toFixed(FINDING_DECIMALS)}× from ${prev.scale} → ${cur.scale} (cap ${growthCap}×)`,
        );
      }
    }
  }
  return findings;
};

export interface SuiteOutcome {
  readonly report: PerfReport;
  readonly regressionCount: number;
}

export const runSuite = async (cfg: PerfConfig): Promise<SuiteOutcome> => {
  const results: ScenarioResult[] = [];
  for (const backend of cfg.backends) {
    results.push(...(await runBackend(backend, cfg)));
  }
  const host = hostInfo();
  const baseline = cfg.updateBaseline ? null : loadBaseline();
  const { rows, regressionCount } = compareAgainstBaseline(results, baseline, cfg.regression);
  if (cfg.updateBaseline) saveBaseline(results, host);
  const { hardBreaches, observations } = budgetVerdictsOf(results, HARD_BUDGET_ROWS);
  const report = {
    ...emptyReport(host),
    results,
    comparisons: rows,
    scalingFindings: scalingFindings(results, cfg.regression.elementGrowthCap),
    budgetBreaches: hardBreaches,
    budgetObservations: observations,
  };
  writeReportArtifacts(report, cfg.reportDir);
  return { report, regressionCount };
};
