// E5-T05 · Import scenarios — preview-path wall-clock per parser over the E7-T01
// generator corpus (roadmap E5-T05 row "Imp: 10k-line parse"; E5-T06 owns the
// preview <2s surface law, so this row is the pipeline's parse-side evidence).
// Budget provenance: EES §6 has NO ImporterPort latency row (only the §5 audit
// row) — importParseMs is a house-declared observation budget, recorded in
// docs/adr-notes/e5-importers.md [follow-up] for the E8-T15 hardening lane.
// The corpus is generateCorpus at the 10k size class (the A3 reuse payoff:
// seeded, byte-identical across lanes — WHAT is parsed matches the parser
// unit/contract lanes). Measured: adapter.preview end-to-end per warm call —
// detect + pure parse + canon stamping + dedupe arithmetic (the commit side is
// O(dupes) stash materialization and belongs to the same measured path; parse
// dominates by orders of magnitude). Determinism evidence: a same-bytes re-
// preview must produce an IDENTICAL modelSummary (pure-parser law).
import type { ImportersAdapter } from '@/infrastructure/importers/index.js';
import { createImportersAdapter } from '@/infrastructure/importers/index.js';
import { platformIds } from '@/shared-kernel/identity/index.js';
import {
  generateCorpus,
  type CorpusFormat,
  type CorpusSizeClass,
} from '../../fixtures/generators/generate.js';
import type { PerfConfig } from '../config.js';
import { BUDGETS } from '../config.js';
import type { BackendSession } from '../backends.js';
import { latencyRow, runsFor } from './shared.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'import';

/** Iteration work budget: one preview costs ≈ one full parse sweep of the file. */
const PARSE_ITERATION_BUDGET = 60_000;

/** The corpus size class under evidence (generator law: 10k/50k/200k). */
const CORPUS_CLASS: CorpusSizeClass = 10_000;
/** The roadmap row's evidence tier equals the generator's smallest class. */
const PERF_SCALE: CorpusSizeClass = 10_000;

/** The importer's fixed clock (parsing law must not depend on wall time). */
const WALL = 1_800_000_000_000;

/** One real adapter per scenario run (fresh stash; ids ride the platform generator). */
const makeAdapter = (): ImportersAdapter =>
  createImportersAdapter({ ids: platformIds, now: () => WALL });

/** One full preview of the format's 10k-class file (detect + parse + stamp). */
const previewOnce = async (adapter: ImportersAdapter, text: string) => {
  const r = await adapter.preview({
    fileMeta: { name: 'perf-corpus', size: text.length },
    bytesRef: { kind: 'text', text },
  });
  if (!r.ok) throw new Error(`perf scenario: import preview → ${r.error.code}`);
  return r.value;
};

const parseFor = async (
  format: CorpusFormat,
  cfg: PerfConfig,
): Promise<{
  readonly samples: readonly number[];
  readonly modelSummary: string;
}> => {
  // The 10k class is the roadmap row; scales parameterize the suite but this
  // family's evidence file is the generator's fixed size class.
  const text = generateCorpus(format, CORPUS_CLASS);
  const adapter = makeAdapter();
  // Warm the parser on a throwaway adapter sweep (JIT + shape caches), then
  // measure on fresh adapters? No — one adapter across iterations is the honest
  // shape (the stash sweep is part of the pipeline's steady-state cost).
  const iterations = runsFor(PERF_SCALE, cfg.samples + cfg.warmup, PARSE_ITERATION_BUDGET);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await previewOnce(adapter, text);
    const ms = performance.now() - t0;
    if (i >= cfg.warmup) samples.push(ms);
  }
  const model = await previewOnce(adapter, text);
  return { samples, modelSummary: model.modelSummary };
};

export const importScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  // The parse path is storage-INDEPENDENT (bytes in → preview model out; the
  // stash is in-memory by design); a dexie-labeled row would claim IDB
  // involvement that does not exist, so the family measures on the memory
  // session only. Scale fan-out: the generators' size classes are the corpus
  // law, so this family's single evidence tier runs once (at the suite's
  // smallest configured scale) instead of pretending per-scale sweeps.
  if (session.name !== 'memory' || scale !== Math.min(...cfg.scales)) return [];
  const backendName = session.name;

  const rows: ScenarioResult[] = [];
  for (const format of ['onetab', 'sessionbuddy', 'netscape'] as const) {
    const measured = await parseFor(format, cfg);
    rows.push(
      latencyRow(
        backendName,
        FAMILY,
        `parse.${format}`,
        PERF_SCALE,
        measured.samples,
        BUDGETS.importParseMs,
      ),
    );
    // Pure-parser law: same bytes ⇒ identical census summary across adapters.
    const replay = await previewOnce(makeAdapter(), generateCorpus(format, CORPUS_CLASS));
    if (replay.modelSummary !== measured.modelSummary) {
      throw new Error(
        `IMPORT-NONDETERMINISM: same-bytes previews diverged (${format}): ${measured.modelSummary} vs ${replay.modelSummary}`,
      );
    }
  }
  return rows;
};
