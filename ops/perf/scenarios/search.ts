// E5-T01 · Search scenarios — query-path latency over the ADR-015 index projection
// (EES §6 SearchRankPort row: p95 ≤ 100ms @10k corpus — the M3 "Find anything"
// release gate). The corpus is a deterministic TabObserved stream (contract-complete
// payloads; append validation is strict), the index builds once per scale via the
// projection engine, and each measured iteration times a fixed probe set so the p95
// surface covers common-term (large postings), AND-intersection, rare-term, and
// medium-frequency shapes. Determinism evidence: probe answers are captured before
// an engine rebuild and must be IDENTICAL after it (§2.11 deletable/rebuildable law).
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';
import { createProjectionEngine } from '@/infrastructure/projections/index.js';
import type { SearchRankHit } from '@/application/ports/search.port.js';
import { createSearchRankAdapter, searchIndexProjector } from '@/infrastructure/search/index.js';
import type { PerfConfig } from '../config.js';
import { BUDGETS } from '../config.js';
import type { BackendSession } from '../backends.js';
import { DEV_A, testId } from '../corpora.js';
import { createPrng } from '../prng.js';
import { appendCorpus, latencyRow, must, runsFor } from './shared.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'search';

const SEED = 7_303;

/** Iteration work budget (doc-touches analogue of the projections 80k event budget):
 *  each iteration costs ≈ one query sweep proportional to corpus size. */
const QUERY_ITERATION_BUDGET = 80_000;

/** ULID fixture base for corpus envelopes (distinct from every other family). */
const ID_BASE = 77_000_000;

/** Corpus wall base + the adapter's fixed `now` (boost-path cost included). */
const WALL = 1_800_000_000_000;
const NOW_SHIFT_MS = 86_400_000;
const NOW = WALL + NOW_SHIFT_MS;

/** Fixture id plumbing (ULID-valid via testId; window/tab ids are registry-required). */
const LEDGE_TAB_ID_OFFSET = 60_000;
const BROWSER_TAB_BASE = 10_000;
const WINDOW_ID_FIXTURE = 2;

/** Result-window size (surface default; the ranker pays full sort cost regardless). */
const RESULT_LIMIT = 20;

/** Deterministic vocabulary: 'pricing' is planted every PRICING_PLANT_EVERY-th doc so
 *  the common-term probe has a large posting list at every grid scale; 'zephyr' is
 *  planted exactly once (doc 0) as the rare-term probe anchor. */
const WORD_POOL = [
  'pricing',
  'atlas',
  'guide',
  'ledger',
  'harbor',
  'signal',
  'metric',
  'canvas',
  'vector',
  'orbit',
  'summit',
  'tundra',
] as const;
const DOMAIN_POOL = ['acme.io', 'globex.dev', 'initech.org', 'umbrella.net'] as const;
const PATH_MOD = 9_971;
const PRICING_PLANT_EVERY = 3;
const SECOND_WORD_OFFSET = 5;

/** Probe shapes: common term, two-term AND, rare single-doc, medium frequency. */
const PROBE_QUERIES = ['pricing', 'pricing atlas', 'zephyr', 'guide'] as const;

/** Probe answer index of the rare-term anchor (validates corpus planting once). */
const RARE_PROBE_INDEX = 2;

/** Contract-complete TabObserved payloads (strict append validation is the law). */
const makeSearchCorpus = (count: number): readonly EventEnvelope[] => {
  const prng = createPrng(SEED);
  const out: EventEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = i + 1;
    const lead =
      i % PRICING_PLANT_EVERY === 0
        ? WORD_POOL[0]
        : (WORD_POOL[prng.int(1, WORD_POOL.length - 1)] ?? 'ledger');
    const second = WORD_POOL[(i + SECOND_WORD_OFFSET) % WORD_POOL.length] ?? 'atlas';
    const title = i === 0 ? `${lead} ${second} zephyr` : `${lead} ${second}`;
    const domain = DOMAIN_POOL[i % DOMAIN_POOL.length] ?? 'acme.io';
    const url = `https://${domain}/p/${seq % PATH_MOD}`;
    const canon = canonicalize(url);
    out.push({
      eventId: testId(ID_BASE + seq) as EventEnvelope['eventId'],
      hlc: { seq, lamport: seq, deviceId: DEV_A as DeviceId, wallClock: WALL + seq },
      type: 'TabObserved',
      payload: {
        ledgeTabId: testId(ID_BASE + LEDGE_TAB_ID_OFFSET + seq),
        browserTabId: BROWSER_TAB_BASE + seq,
        windowId: WINDOW_ID_FIXTURE,
        url,
        urlCanon: canon.canonForm,
        canonRulesV: canon.rulesVersion,
        title,
        domain: canon.domain,
        ts: WALL + seq,
      } as EventEnvelope['payload'],
      producerContext: 'sw',
    });
  }
  return out;
};

/** Ranked-hit id sequence — the cross-rebuild determinism comparison surface. */
const probeOnce = async (
  rank: ReturnType<typeof createSearchRankAdapter>,
): Promise<readonly (readonly string[])[]> => {
  const out: string[][] = [];
  for (const q of PROBE_QUERIES) {
    const reply = must(await rank.query({ q, scope: 'all', limit: RESULT_LIMIT }), `query(${q})`);
    if (reply.kind !== 'ok') throw new Error(`perf scenario: probe answered ${reply.kind}`);
    out.push(reply.answer.hits.map((h: SearchRankHit) => h.tabId));
  }
  return out;
};

export const searchScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const backend = await session.open();
  const corpus = makeSearchCorpus(scale);
  await appendCorpus(backend.journal, corpus, `perf-search-${scale}`);

  // Build the projection (index build cost is the projections.rebuild family's row;
  // THIS row measures the steady-state query path @corpus — the §6 port budget).
  const projections = createProjectionEngine({
    engine: backend.engine,
    journal: backend.journal,
    projectors: [searchIndexProjector],
  });
  must(await projections.applyFromJournal(DEV_A), 'applyFromJournal');
  const rank = createSearchRankAdapter({ engine: backend.engine, projections, now: () => NOW });

  const iterations = runsFor(scale, cfg.samples + cfg.warmup, QUERY_ITERATION_BUDGET);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    for (const q of PROBE_QUERIES) {
      const t0 = performance.now();
      must(await rank.query({ q, scope: 'all', limit: RESULT_LIMIT }), `query(${q})`);
      const ms = performance.now() - t0;
      if (i >= cfg.warmup) samples.push(ms);
    }
    if (i === cfg.warmup) {
      // Sanity: the planted anchors must actually rank (a blind corpus voids the row).
      const answers = await probeOnce(rank);
      const common = answers[0] ?? [];
      const rare = answers[RARE_PROBE_INDEX] ?? [];
      if (common.length === 0 || rare.length !== 1) {
        throw new Error('perf scenario: search corpus anchors missing from probe answers');
      }
    }
  }

  // Determinism law: probe answers are stable across a full engine rebuild. The
  // rebuild replays the whole corpus through the index fan-out (real algorithmic
  // cost — projections.rebuild.* is the family's build-cost row), so evidence rides
  // the SMALLEST memory tier; engine-wide rebuild determinism for this projector is
  // already proven in the unit lane (adapter rebuild-envelope) and property lane
  // (replay-purge law covers the search_index shelf). Dexie-tier rebuild evidence
  // would double this family's wall-clock for zero new information.
  const isEvidenceTier = backend.name === 'memory' && scale === Math.min(...cfg.scales);
  if (isEvidenceTier) {
    const before = await probeOnce(rank);
    must(await projections.rebuild('searchIndex'), 'rebuild(searchIndex)');
    const after = await probeOnce(rank);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('SEARCH-NONDETERMINISM: probe answers diverged across engine rebuild');
    }
  }

  return [latencyRow(backend.name, FAMILY, 'query', scale, samples, BUDGETS.searchQueryP95Ms)];
};
