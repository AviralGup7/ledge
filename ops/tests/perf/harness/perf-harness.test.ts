// E7-T02 · Perf lane gate (EES §8 "Performance: §7.1–7.3 budgets on reference
// profile; regression compare vs baseline build" · nightly + release-gating).
// Runs the full ops/perf suite and asserts the three law classes:
//   1. BUDGETS — doc rows (EES §7.1) with literal numbers (headroom is 10–100×).
//   2. REGRESSION — meaningful deltas vs the recorded baseline (R-10 refined).
//   3. SCALING — no superlinear per-element growth on the deterministic backend.
// Determinism evidence (twin-replay digest equality, rebuild≡driven) is asserted
// inside the scenarios themselves: a violation throws and this suite is red.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../perf/config.js';
import { runSuite } from '../../../perf/suite.js';
import type { ScenarioResult } from '../../../perf/types.js';

/**
 * House law: a single test finishes inside 60s or it fails — unless an exception
 * is declared. The declared exception is the full-grid reference profile run
 * (`PERF_GRID=full PERF_SUITE_TIMEOUT_MS=2400000`): minutes-long by design,
 * reference-hardware evidence, never the CI gate. The default CI/nightly profile
 * is built to land well under the 60s law even on loaded virtualized runners.
 */
const HOURLY_LAW_MS = 60_000;
const SUITE_TIMEOUT_MS = (() => {
  const raw = Number(process.env['PERF_SUITE_TIMEOUT_MS']);
  return Number.isInteger(raw) && raw > 0 ? raw : HOURLY_LAW_MS;
})();

/** Mission metric inventory — every row class the mission demands must exist. */
const REQUIRED_ROWS = [
  'journal.append',
  'journal.append.batch',
  'journal.replay',
  'journal.scan.tail',
  'journal.scan.full',
  'journal.checkpoint',
  'journal.memory.append.peak',
  'journal.memory.append.steady',
  'projections.rebuild.missions',
  'projections.ingest.apply',
  'snapshots.generate',
  'snapshots.restore',
  'lifecycle.boot.cold',
  'lifecycle.boot.warm',
  'lifecycle.wake',
  'lifecycle.ack',
  'lifecycle.park.ack',
  'lifecycle.memory.boot.peak',
  'lifecycle.memory.boot.steady',
  'maintenance.compaction',
  'maintenance.purge',
  'maintenance.recovery.duration',
  'storage.idb.txn',
  'ingest.event.latency',
] as const;

const rowName = (r: ScenarioResult): string => (r.key.split('/')[1] ?? '').split('/')[0] ?? '';

/** Compaction rows are structural no-ops at/below the sealed-segment cap (L1 law). */
const SEGMENT_CAP = 500;

describe('E7-T02 perf harness (M1 exit gate)', () => {
  it(
    'runs the suite: budgets green, no meaningful regressions, no superlinear growth',
    { timeout: SUITE_TIMEOUT_MS },
    async () => {
      const cfg = loadConfig();
      const { report, regressionCount } = await runSuite(cfg);

      // 1 · row inventory (mission: "Measure at minimum" list is fully covered;
      // maintenance.migration is dexie-only and asserted separately below).
      const names = new Set(report.results.map(rowName));
      const maxScale = Math.max(...report.results.map((r) => r.scale));
      for (const required of REQUIRED_ROWS) {
        if (
          (required === 'maintenance.compaction' || required === 'maintenance.purge') &&
          maxScale <= SEGMENT_CAP
        ) {
          continue; // no sealed segment exists at this grid ⇒ the sweep is a no-op by law
        }
        expect(names.has(required), `missing scenario row: ${required}`).toBe(true);
      }
      if (cfg.backends.includes('dexie')) {
        expect(names.has('maintenance.migration'), 'missing migration row on dexie lane').toBe(
          true,
        );
      }

      // 2 · doc-budget rows exist with their literal EES numbers and are green.
      const budgets = report.results.filter((r) => r.budget !== undefined);
      expect(
        budgets.some((r) => rowName(r) === 'lifecycle.wake' && r.budget === 200),
        'wake ≤200ms p95 budget row missing',
      ).toBe(true);
      expect(
        budgets.some((r) => rowName(r) === 'lifecycle.park.ack' && r.budget === 500),
        'park ack ≤500ms p95 budget row missing',
      ).toBe(true);
      expect(report.budgetBreaches, report.budgetBreaches.join('\n')).toEqual([]);

      // 3 · regression compare + scaling law.
      expect(regressionCount).toBe(0);
      expect(report.scalingFindings, report.scalingFindings.join('\n')).toEqual([]);

      // 4 · the machine-readable artifacts exist (historical comparison input).
      expect(existsSync(`${cfg.reportDir}/perf-report.json`)).toBe(true);
      expect(existsSync(`${cfg.reportDir}/perf-report.md`)).toBe(true);
    },
  );
});
