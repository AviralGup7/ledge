// E7-T02 · Ingest scenarios — event ingestion latency: the steady-state path one
// observed browser event takes to become truth + read-model (append + apply), and
// its amortized batch twin. Distinct from journal.append (no projection) and from
// projections.ingest.apply (no journal) — this is the end-to-end ingest hop.
import { createProjectionEngine } from '@/infrastructure/projections/index.js';
import { V1_PROJECTORS } from '@/infrastructure/projections/index.js';
import type { PerfConfig } from '../config.js';
import type { BackendSession } from '../backends.js';
import { makeJournalCorpus, DEV_A } from '../corpora.js';
import { latencyRow, must } from './shared.js';
import { nowMs } from '../timing.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'ingest';

const SEED = 7_401;

export const ingestScenarios = async (
  session: BackendSession,
  scale: number,
  _cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const backend = await session.open();
  const projections = createProjectionEngine({
    engine: backend.engine,
    journal: backend.journal,
    projectors: V1_PROJECTORS,
  });
  // One-event batches, seq-contiguous (the chrome-observation arrival pattern),
  // driven through apply() — the ingest hub's real hop (applyFromJournal would be
  // O(n) per event and says nothing about steady-state arrival cost).
  const corpus = makeJournalCorpus(scale, SEED, DEV_A);
  const iterations = Math.min(scale, SINGLE_INGEST_CAP);
  const ms: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const event = corpus[i];
    if (event === undefined) continue;
    const t0 = nowMs();
    must(
      await backend.journal.append([event], { idempotencyKey: `perf-ingest-${scale}-${i}` }),
      'ingest.append',
    );
    must(await projections.apply([event]), 'ingest.apply');
    // The first event warms adapter state; drop it from stats.
    if (i > 0) ms.push(nowMs() - t0);
  }
  return [latencyRow(backend.name, FAMILY, 'event.latency', scale, ms)];
};

/** Per-event loop iterations regardless of grid scale. Measured (60s-law
 *  tuning, E7-T02): ~2ms (memory) → ~8ms (dexie) per event, so a 2000-loop costs
 *  up to ~16s per dexie tier; 200 samples already stabilize p95/p99 for a
 *  distribution row, and the row's law is per-event latency shape, not volume. */
const SINGLE_INGEST_CAP = 200;
