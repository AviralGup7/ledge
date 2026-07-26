// E5-T05 · Import-scenario smoke — the import.parse family wiring is proven between
// nightly full-grid runs: memory-only honesty, per-format row naming, the house
// budget attachment, and suite-scale single-tier behavior. This is NOT the perf
// gate (that's the E7-T02 harness at full grid); it's the wiring tripwire. Small
// by construction: one memory session, smallest scale, minimal samples.
import { describe, expect, it } from 'vitest';
import { createBackendSession } from '../../../perf/backends.js';
import { BUDGETS, loadConfig } from '../../../perf/config.js';
import { importScenarios } from '../../../perf/scenarios/import.js';

const SMOKE_SCALE = 100;
const PERF_TIMEOUT_MS = 55_000;

describe('E5-T05 import.parse scenario wiring', () => {
  it(
    'emits one budgeted parse row per format on the memory session only',
    { timeout: PERF_TIMEOUT_MS },
    async () => {
      const cfg = loadConfig({
        PERF_GRID: 'ci',
        PERF_SCALES: String(SMOKE_SCALE),
        PERF_BACKENDS: 'memory',
        PERF_SAMPLES: '1',
        PERF_WARMUP: '1',
      });
      const rows = await importScenarios(createBackendSession('memory'), SMOKE_SCALE, cfg);
      expect(rows.map((r) => r.key)).toEqual([
        'memory/import.parse.onetab/10000',
        'memory/import.parse.sessionbuddy/10000',
        'memory/import.parse.netscape/10000',
      ]);
      for (const row of rows) {
        expect(row.family).toBe('import');
        expect(row.scale).toBe(10_000); // generator 10k class is the evidence tier
        expect(row.kind).toBe('latency');
        expect(row.unit).toBe('ms');
        expect(row.budget).toBe(BUDGETS.importParseMs);
        expect(row.stats.max).toBeLessThan(BUDGETS.importParseMs);
        expect(row.stats.median).toBeGreaterThan(0);
      }

      // Honesty: the family claims no dexie involvement (storage-independent parse).
      const dexieRows = await importScenarios(createBackendSession('dexie'), SMOKE_SCALE, cfg);
      expect(dexieRows).toEqual([]);
      // Single evidence tier: non-minimal scales emit nothing (the 10k class is law).
      const offTier = await importScenarios(createBackendSession('memory'), SMOKE_SCALE * 10, cfg);
      expect(offTier).toEqual([]);
    },
  );
});
