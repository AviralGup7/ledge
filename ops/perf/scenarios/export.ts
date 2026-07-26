// E5-T03 · Export scenarios — the render pipeline's wall-clock across corpus
// scales (EES §6 ExportRendererPort bench: "100k-tab export streams, ≤60s worst";
// EES §12 exporters DoD "Bench: 100k-tab stream ≤60s"). Measured: jsonParts +
// verified assembly (the seal format — html/md render from the same model).
// The model is fabricated in-memory (the render path is store-independent; the
// projection-snapshot read cost is the storage/projections families' row).
// Determinism evidence: a same-model re-render must produce an IDENTICAL
// manifest checksum (rebuildable-artifact law, ADR-045).
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import {
  assembleVerified,
  buildModel,
  jsonParts,
  streamParts,
  type CanonicalExportModel,
} from '@/infrastructure/exporters/index.js';
import { testId } from '../corpora.js';
import type { PerfConfig } from '../config.js';
import { BUDGETS } from '../config.js';
import type { BackendSession } from '../backends.js';
import { createPrng } from '../prng.js';
import { latencyRow, runsFor } from './shared.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'export';

const SEED = 7_407;

/** Iteration work budget: a full render costs ≈ one serialization sweep. */
const RENDER_ITERATION_BUDGET = 150_000;

/** Corpus shape: tabs per mission (deep-library realism without 1-mission skew). */
const TABS_PER_MISSION = 100;
const ID_BASE = 88_000_000;
/** Fixture id plumbing (tab ids offset from mission ids inside the ULID space). */
const TAB_ID_OFFSET = 500_000;
const WALL = 1_800_000_000_000;
const TITLE_WORD_MOD = 7;
/** Title vocabulary spread (deterministic variety for tokenization cost). */
const REV_MAX = 50;

const BUILD_STAMP = 'perf-build';
const CANON_V = 1;

/** Deterministic model: `scale` tabs across scale/100 missions (no loose shelf —
 *  the scaling signal measures the membership path, which is the hot one). */
const makeModel = (scale: number) => {
  const prng = createPrng(SEED);
  const missions: MissionViewRow[] = [];
  const tabs: TabStoreRow[] = [];
  const missionCount = Math.max(1, Math.ceil(scale / TABS_PER_MISSION));
  for (let m = 0; m < missionCount; m += 1) {
    const missionId = testId(ID_BASE + m);
    const tabIds: string[] = [];
    for (let t = 0; t < TABS_PER_MISSION; t += 1) {
      const n = m * TABS_PER_MISSION + t;
      if (n >= scale) break;
      const tabId = testId(ID_BASE + TAB_ID_OFFSET + n);
      tabIds.push(tabId);
      tabs.push({
        ledgeTabId: tabId,
        missionId,
        url: `https://site-${n % TITLE_WORD_MOD}.test/item/${n}`,
        title: `doc ${n} rev ${prng.int(1, REV_MAX)}`,
        domain: `site-${n % TITLE_WORD_MOD}.test`,
        state: 'kept',
        firstSeenAt: WALL - n,
        lastActiveAt: WALL,
      });
    }
    missions.push({
      missionId,
      name: `mission-${m}`,
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabIds,
      createdAt: WALL - m,
      lastActiveAt: WALL,
    });
  }
  return buildModel({
    scope: 'all',
    rows: { missions, tabs },
    build: BUILD_STAMP,
    canonRulesV: CANON_V,
    now: () => WALL,
  });
};

/** One full verified json render (parts + chunk-verify + manifest seal). */
const renderOnce = async (model: CanonicalExportModel) => {
  const parts = jsonParts(model);
  const assembled = await assembleVerified('json', () => streamParts(parts));
  if (!assembled.ok) throw new Error(`perf scenario: export render → ${assembled.error.code}`);
  return assembled.value;
};

export const exportScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  // The render path is storage-INDEPENDENT (canonical model → verified bytes);
  // a dexie-labeled row would claim IDB involvement that does not exist, so the
  // family measures on the memory session only. Store-read cost is the
  // storage/projections families' row, not this one's.
  if (session.name !== 'memory') return [];
  const backendName = session.name;
  const model = makeModel(scale);

  const iterations = runsFor(scale, cfg.samples + cfg.warmup, RENDER_ITERATION_BUDGET);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await renderOnce(model);
    const ms = performance.now() - t0;
    if (i >= cfg.warmup) samples.push(ms);
  }

  // Rebuildable-artifact law: same model ⇒ identical seal (min memory tier is
  // enough — the deterministic-parts law is backend-independent by construction).
  const isEvidenceTier = backendName === 'memory' && scale === Math.min(...cfg.scales);
  if (isEvidenceTier) {
    const a = await renderOnce(model);
    const b = await renderOnce(model);
    if (a.manifest.manifestChecksum !== b.manifest.manifestChecksum) {
      throw new Error('EXPORT-NONDETERMINISM: same-model renders sealed differently');
    }
  }

  return [latencyRow(backendName, FAMILY, 'render', scale, samples, BUDGETS.exportRenderMs)];
};
