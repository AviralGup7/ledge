// E7-T02 · Projection scenarios — rebuild throughput, ingest-path apply cost
// (§7.1: ≤5ms/event amortized, burst 500), and the rebuild≡live determinism law.
// Configurable projection count: PROJ_SETS lets the suite vary the projector
// population (mission requirement) without touching scenario code.
import type { ProjectorDef } from '@/application/ports/projection-engine.port.js';
import { createProjectionEngine } from '@/infrastructure/projections/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import { missionsProjector } from '@/infrastructure/projections/core/projectors/missions.projector.js';
import { recentlyClosedProjector } from '@/infrastructure/projections/core/projectors/recently-closed.projector.js';
import { sessionsProjector } from '@/infrastructure/snapshots/sessions.projector.js';
import { stableStringify, fnv1a64 } from '@/shared-kernel/canon/index.js';
import type { PerfConfig } from '../config.js';
import { BUDGETS, INGEST_BURST } from '../config.js';
import type { Backend, BackendSession } from '../backends.js';
import { makeJournalCorpus, DEV_A } from '../corpora.js';
import { appendCorpus, latencyRow, must, rateOf, runsFor, throughputRow } from './shared.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'projections';

const SEED = 7_101;

/** Total projector-applied events across all rebuild iterations per view. */
const REBUILD_EVENT_BUDGET = 80_000;

/** Mission knob: projection population presets (1 … 3 v1 projectors). */
const PROJ_SETS: Readonly<Record<string, readonly ProjectorDef[]>> = {
  single: [missionsProjector],
  full: [missionsProjector, recentlyClosedProjector, sessionsProjector],
};

/** Canonical digest of one view's store rows (determinism-law comparison surface). */
const viewDigest = async (backend: Backend, store: ProjectorDef['store']): Promise<string> =>
  must(
    await backend.engine.txn([store], 'readonly', async (tx) => {
      const rows = await tx.table<StoredRecord>(store).toArray();
      const canon = rows
        .map((r) => stableStringify(r))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return fnv1a64(canon.join('|'));
    }),
    'viewDigest',
  );

const projectorsOf = (set: keyof typeof PROJ_SETS): readonly ProjectorDef[] =>
  set === 'single' ? [missionsProjector] : [...(PROJ_SETS['full'] ?? [])];

export const projectionScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
  set: keyof typeof PROJ_SETS = 'full',
): Promise<readonly ScenarioResult[]> => {
  const out: ScenarioResult[] = [];
  const backend = await session.open();
  const corpus = makeJournalCorpus(scale, SEED, DEV_A);
  await appendCorpus(backend.journal, corpus, `perf-proj-${scale}`);

  const projectors = projectorsOf(set);

  // ── rebuild: wipe the view + replay the journal, per projector ──────────────
  const rebuildIterations = Math.max(
    cfg.warmup + 1,
    runsFor(scale, cfg.samples + cfg.warmup, REBUILD_EVENT_BUDGET),
  );
  for (const def of projectors) {
    const engine = createV1Engine(backend, def);
    const runMs: number[] = [];
    const rates: number[] = [];
    for (let i = 0; i < rebuildIterations; i += 1) {
      const t0 = performance.now();
      const r = must(await engine.rebuild(def.view), `rebuild(${def.view})`);
      const ms = performance.now() - t0;
      if (i >= cfg.warmup) {
        runMs.push(ms);
        rates.push(rateOf(r.eventsApplied > 0 ? r.eventsApplied : scale, ms));
      }
    }
    out.push(latencyRow(backend.name, FAMILY, `rebuild.${def.view}`, scale, runMs));
    out.push(throughputRow(backend.name, FAMILY, `rebuild.${def.view}`, scale, rates));
  }

  // ── ingest path: apply() bursts of INGEST_BURST; amortized ms/event ─────────
  {
    // Rewind: a fresh image keeps watermarks honest (apply law: below-wm skipped).
    const fresh = await session.openFresh();
    await appendCorpus(fresh.journal, corpus, `perf-proj-ingest-${scale}`);
    const freshEngine = createV1Engine(fresh, ...projectors);
    const msPerEvent: number[] = [];
    let cursor = 0;
    while (cursor < corpus.length) {
      const burst = corpus.slice(cursor, cursor + INGEST_BURST);
      cursor += burst.length;
      const t0 = performance.now();
      must(await freshEngine.apply(burst), 'apply(burst)');
      const ms = performance.now() - t0;
      if (cursor > INGEST_BURST) msPerEvent.push(ms / burst.length); // first burst = warmup
    }
    out.push(
      latencyRow(
        fresh.name,
        FAMILY,
        'ingest.apply',
        scale,
        msPerEvent,
        BUDGETS.projectionMsPerEvent,
      ),
    );
    // Determinism law: driven state ≡ rebuilt state, digest-proven.
    const drivenDigests = new Map<string, string>();
    for (const def of projectors) {
      drivenDigests.set(def.view, await viewDigest(fresh, def.store));
    }
    for (const def of projectors) {
      must(await freshEngine.rebuild(def.view), `rebuild(${def.view})#det`);
      const rebuilt = await viewDigest(fresh, def.store);
      if (rebuilt !== drivenDigests.get(def.view)) {
        throw new Error(
          `PROJECTION-NONDETERMINISM: rebuild(${def.view}) diverged from driven state`,
        );
      }
    }
  }

  return out;
};

/** The engine factory (deps narrowed to a single def or the full set). */
const createV1Engine = (backend: Backend, ...defs: readonly ProjectorDef[]) =>
  createProjectionEngine({ engine: backend.engine, journal: backend.journal, projectors: defs });
