// E7-T02 · Perf-harness self-verification — the harness measures the Truth Engine,
// so the harness itself must be proven: stats math, PRNG/corpus determinism,
// regression-verdict law, config parsing. Fast, no I/O beyond a tmp baseline file.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize, PCT_P95, PCT_P99 } from '../../../perf/stats.js';
import { createPrng } from '../../../perf/prng.js';
import { loadConfig, BUDGETS } from '../../../perf/config.js';
import { makeJournalCorpus, DEV_A } from '../../../perf/corpora.js';
import {
  compareAgainstBaseline,
  loadBaseline,
  saveBaseline,
  compareStatisticOf,
} from '../../../perf/baseline.js';
import type { BaselineFile } from '../../../perf/types.js';
import { REPORT_SCHEMA_V } from '../../../perf/types.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';

const baselineFileForTest = (scenarios: Record<string, number>): BaselineFile => ({
  schemaV: REPORT_SCHEMA_V,
  recordedAt: '1970-01-01T00:00:00.000Z',
  host: {
    node: 'v0',
    platform: 'test',
    arch: 'test',
    cpuModel: 'test',
    cpuCount: 1,
    totalMemMB: 1,
  },
  scenarios,
});

describe('perf harness self-check · stats', () => {
  it('summarize produces the mission output columns', () => {
    const s = summarize([10, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.n).toBe(10);
    expect(s.mean).toBeCloseTo(5.5, 3);
    expect(s.median).toBeCloseTo(5.5, 3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.p95).toBeGreaterThan(8.9);
    expect(s.p95).toBeLessThanOrEqual(10);
    expect(s.p99).toBeGreaterThanOrEqual(s.p95);
    expect(s.stddev).toBeCloseTo(2.872, 2);
  });
  it('empty and singleton samples stay total', () => {
    expect(summarize([]).n).toBe(0);
    const one = summarize([4]);
    expect(one.p95).toBe(4);
    expect(one.stddev).toBe(0);
  });
  it('percentile constants remain the contract values', () => {
    expect(PCT_P95).toBe(95);
    expect(PCT_P99).toBe(99);
  });
});

describe('perf harness self-check · determinism', () => {
  it('mulberry32: same seed, same stream', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    for (let i = 0; i < 100; i += 1) expect(a.next()).toBe(b.next());
    const c = createPrng(43);
    expect(createPrng(42).next()).not.toBe(c.next());
  });
  it('journal corpus is byte-identical across constructions and lawful', () => {
    const a = makeJournalCorpus(500, 99, DEV_A);
    const b = makeJournalCorpus(500, 99, DEV_A);
    expect(stableStringify(a)).toBe(stableStringify(b));
    const c = makeJournalCorpus(500, 100, DEV_A);
    expect(stableStringify(a)).not.toBe(stableStringify(c));
    // Append-law invariants the corpus depends on: contiguous seqs, lamport == seq.
    a.forEach((e, i) => {
      expect(e.hlc.seq).toBe(i + 1);
      expect(e.hlc.lamport).toBe(e.hlc.seq);
      expect(e.hlc.deviceId).toBe(DEV_A);
    });
    // The mix exercises the real vocabulary (all three projector families).
    const types = new Set(a.map((e) => e.type));
    expect(types.has('MissionFormed')).toBe(true);
    expect(types.has('TabObserved')).toBe(true);
    expect(types.has('TabClosedExternal')).toBe(true);
  });
});

describe('perf harness self-check · regression verdicts', () => {
  const cfg = loadConfig({}).regression;
  const mkRow = (key: string, kind: 'latency' | 'throughput' | 'memory', statValue: number) => ({
    key,
    backend: 'memory' as const,
    family: 'test',
    scale: 1,
    kind,
    unit: kind === 'memory' ? 'MB' : 'ms',
    stats: {
      n: 1,
      mean: statValue,
      median: statValue,
      p95: statValue,
      p99: statValue,
      min: statValue,
      max: statValue,
      stddev: 0,
    },
  });
  it('latency comparison rides the MEDIAN — the anti-flake statistic law (schema v2)', () => {
    // Measured on this profile: at the CI sample count p95 ≈ max, and max jitter
    // reached 3× between identical-code runs. A row whose p95 tripled but whose
    // median moved 15% must compare at 15% — spikes are load, medians are code.
    const row = mkRow('memory/test.spiky/1', 'latency', 10);
    const spiky = {
      ...row,
      stats: { ...row.stats, median: 11.5, p95: 30, max: 44 },
    };
    expect(compareStatisticOf(spiky)).toBe(11.5);
    const base = baselineFileForTest({ 'memory/test.spiky/1': 10 });
    const outcome = compareAgainstBaseline([spiky], base, cfg);
    expect(outcome.rows[0]?.verdict).toBe('pass');
    expect(outcome.regressionCount).toBe(0);
  });
  it('flat 10% wobble never regresses; meaningful blow-outs always do', () => {
    const base = baselineFileForTest({
      'memory/test.latency/1': 10,
      'memory/test.rate/1': 1000,
      'memory/test.mem/1': 40,
    });
    const pass = compareAgainstBaseline(
      [mkRow('memory/test.latency/1', 'latency', 11.5)],
      base,
      cfg,
    );
    expect(pass.rows[0]?.verdict).toBe('pass');
    const blowout = compareAgainstBaseline(
      [mkRow('memory/test.latency/1', 'latency', 17)],
      base,
      cfg,
    );
    expect(blowout.rows[0]?.verdict).toBe('regressed');
    expect(blowout.regressionCount).toBe(1);
    const throughput = compareAgainstBaseline(
      [mkRow('memory/test.rate/1', 'throughput', 500)],
      base,
      cfg,
    );
    expect(throughput.rows[0]?.verdict).toBe('regressed');
    const memory = compareAgainstBaseline([mkRow('memory/test.mem/1', 'memory', 45)], base, cfg);
    expect(memory.rows[0]?.verdict).toBe('pass'); // +5MB < 32MB slack AND < 1.5×
    const absent = compareAgainstBaseline([mkRow('memory/test.new/1', 'latency', 5)], base, cfg);
    expect(absent.rows[0]?.verdict).toBe('baseline-absent');
    expect(absent.regressionCount).toBe(0);
  });
  it('baseline file round-trips and budget rows never enter it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledge-perf-'));
    const path = join(dir, 'baseline.json');
    const rows = [
      mkRow('memory/test.latency/1', 'latency', 10),
      { ...mkRow('memory/test.budget/1', 'latency', 1), budget: BUDGETS.wakeP95Ms },
    ];
    saveBaseline(rows, baselineFileForTest({}).host, path);
    const loaded = loadBaseline(path);
    expect(loaded?.scenarios['memory/test.latency/1']).toBe(10);
    expect(loaded?.scenarios['memory/test.budget/1']).toBeUndefined();
    expect(loadBaseline(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('perf harness self-check · config', () => {
  it('defaults deliver the 60-second-law CI profile', () => {
    const cfg = loadConfig({});
    expect(cfg.scales).toEqual([100, 1_000]);
    expect(cfg.dexieScales).toEqual([1_000]);
    expect(cfg.samples).toBe(7);
    expect(cfg.warmup).toBe(1);
    expect(cfg.backends).toEqual(['memory', 'dexie']);
    expect(cfg.updateBaseline).toBe(false);
  });
  it('PERF_GRID=full restores the mission reference grid', () => {
    const cfg = loadConfig({ PERF_GRID: 'full' });
    expect(cfg.scales).toEqual([100, 1_000, 10_000, 50_000]);
    expect(cfg.dexieScales).toEqual([1_000, 10_000]);
    expect(cfg.samples).toBe(21);
    expect(cfg.warmup).toBe(3);
  });
  it('env overrides parse and garbage falls back', () => {
    const cfg = loadConfig({
      PERF_SCALES: '100,1000',
      PERF_BACKENDS: 'memory',
      PERF_SAMPLES: '5',
    });
    expect(cfg.scales).toEqual([100, 1_000]);
    expect(cfg.backends).toEqual(['memory']);
    expect(cfg.samples).toBe(5);
    const junk = loadConfig({ PERF_SCALES: 'nope,,0' });
    expect(junk.scales).toEqual([100, 1_000]);
  });
});
