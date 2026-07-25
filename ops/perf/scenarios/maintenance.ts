// E7-T02 · Maintenance scenarios — the background-window family (§7.1 compaction
// rows, purge-law throughput), the migration runner, and boot reconcile duration
// (recovery RTO ≤ 5s evidence). All run on seeded corpora; seeded content is a pure
// function of (scale, seed), so the purge hit-pattern is identical across hosts.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createMigrationRunner } from '@/infrastructure/storage/migrations/runner.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createDexieStorageEngine, SCHEMA_VERSION_V1 } from '@/infrastructure/storage/index.js';
import { SCHEMA_V1 } from '@/infrastructure/storage/schema/schema.v1.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import { createChromeStorageAreaAdapter } from '@/infrastructure/chrome/index.js';
import { createIntentLedger } from '@/infrastructure/intents/index.js';
import { runBootSequence } from '@/infrastructure/recovery/index.js';
import { platformIds } from '@/shared-kernel/identity/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { SEGMENT_ENTRY_CAP } from '@/infrastructure/journal/core/types.js';
import type { PerfConfig } from '../config.js';
import { BUDGETS } from '../config.js';
import type { Backend, BackendSession } from '../backends.js';
import { DEV_A, IDS, makeJournalCorpus, makePurgedTargetEvents, testId } from '../corpora.js';
import { appendCorpus, latencyRow, must, rateOf, runsFor, throughputRow } from './shared.js';
import { nowMs, perfTrace, perfTraceWall } from '../timing.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'maintenance';

const SEED = 7_301;

/** Salts keep maintenance corpora disjoint from sibling families. */
const PURGE_MISSION_SALT = 999_999;
const MIGRATION_MISSION_SALT = 500_000;
const RECOVERY_SALT = 300_000;
const RECOVERY_BROWSER_TAB_BASE = 20_000;

/** Compact re-seeds per iteration; cap total seeded events across iterations. */
const COMPACT_EVENT_BUDGET = 150_000;
const PURGE_TARGET_MISSION = testId(IDS.MISSION_BASE + PURGE_MISSION_SALT);
/**
 * Measured volume knob (E7-T02 harness finding F-migration-cliff): on
 * fake-indexeddb a put inside a Dexie VERSIONCHANGE upgrade transaction costs
 * ~2.3ms/row PER SECONDARY INDEX (state-only / lastActiveAt-only / compound-only
 * ≈ 6.8s each at 3000 rows; the full 3-index missions schema ≈ 21s at 3000,
 * >60s at 5000 — the lane's eternal "hang"), while the identical write in a
 * normal transaction measures ~0.01ms/row/index. ADR-034's rollback law pins
 * transforms inside the versionchange txn, so CI measures the runner at 500
 * rows (~0.6s whole-migrate); grid-scale migration evidence is a PERF_GRID=full
 * profile run. The cliff itself is recorded in the E7-T02 adr-note (E8-T15
 * owns mitigation exploration: chunked backfill transforms, Chrome-real delta).
 */
const MIGRATION_ROW_COUNT = 500;
const MIGRATION_FIELD = 'touched';
/** Compaction sweep density: lighter matching (scan-dominated) than purge's. */
const COMPACT_TARGET_SHARE = 0.05;
/** Purge sweep density (per-entry exclusion rate is the headline metric). */
const PURGE_DENSE_SHARE = 0.25;
const ISSUED_AT_BASE = 1_800_000_000_000;

// ── compaction: exclusion sweep over a seeded stream (reload per iteration so the
//    measured run is the real first-sweep cost, not a resume no-op) ───────────────

const compactScenario = async (
  makeBackend: () => Promise<Backend>,
  scale: number,
  cfg: PerfConfig,
  backendName: Backend['name'],
  rowName: string,
  targetShare: number,
): Promise<readonly ScenarioResult[]> => {
  const runMs: number[] = [];
  const rates: number[] = [];
  const excludedRates: number[] = [];
  // Each iteration re-seeds (a compacted image can't be re-swept), so total work
  // is capped by the event budget across iterations at the 50k tier.
  const iterations = runsFor(scale, cfg.samples, COMPACT_EVENT_BUDGET);
  for (let i = 0; i < iterations; i += 1) {
    const backend = await makeBackend();
    const corpus = purgeCorpusWithTargets(scale, targetShare, SEED + i);
    await appendCorpus(backend.journal, corpus, `perf-compact-seed-${i}`);
    const head = corpus.length;
    // Horizon strictly below the head (L1 law: the open segment stays out of window).
    const throughSeq = head - 1;
    const t0 = nowMs();
    const report = must(
      await backend.journal.compact({
        deviceId: DEV_A,
        throughSeq,
        purgeChains: [
          {
            kind: 'mission',
            id: PURGE_TARGET_MISSION,
            purgedAt: ISSUED_AT_BASE + i,
            purgeEpoch: 0,
          },
        ],
        chunkSegments: 1,
      }),
      'compact',
    );
    const ms = nowMs() - t0;
    if (report.entriesExcluded === 0) {
      throw new Error(`${rowName}: exclusion corpus matched nothing — workload broken`);
    }
    if (i >= cfg.warmup) {
      runMs.push(ms);
      rates.push(rateOf(scale, ms));
      excludedRates.push(rateOf(report.entriesExcluded, ms));
    }
  }
  return [
    latencyRow(backendName, FAMILY, rowName, scale, runMs),
    throughputRow(backendName, FAMILY, rowName, scale, rates),
    throughputRow(backendName, FAMILY, `${rowName}.excluded`, scale, excludedRates),
  ];
};

/** Compaction with zero exclusion matches rewrites nothing — for a faithful workload
 *  the purge corpus plants events whose missionId the chain targets. */
const purgeCorpusWithTargets = (
  scale: number,
  targetShare: number,
  seed: number,
): readonly EventEnvelope[] => {
  const targetCount = Math.max(1, Math.floor(scale * targetShare));
  const targets = makePurgedTargetEvents(targetCount, PURGE_TARGET_MISSION, seed, DEV_A);
  const rest = makeJournalCorpus(scale - targetCount, seed, DEV_A).map((e, k) => ({
    ...e,
    hlc: { ...e.hlc, seq: targetCount + k + 1, lamport: targetCount + k + 1 },
  }));
  return [...targets, ...rest];
};

// ── migration: synthetic v1→v2 step over a seeded store (Dexie upgrade; row
//    count is MIGRATION_ROW_COUNT — see its measured-cliff comment) ─────────────

const PREF_STORE = 'missions' as const;

const migrationScenario = async (cfg: PerfConfig): Promise<readonly ScenarioResult[]> => {
  const ms: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const indexedDB = new IDBFactory() as unknown as globalThis.IDBFactory;
    const idbKeyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange;
    const databaseName = `ledge-perf-migration-${i}`;
    const seedStart = Date.now();
    // Seed the base image at v1 (the world.engine pattern: bytes exist before the
    // migrator's own handle opens — ADR-034 law 1 then lawfully requires checkpoint).
    const base = createDexieStorageEngine({ databaseName, indexedDB, idbKeyRange });
    must(await base.open(), 'migration.seed.open');
    must(
      await base.txn([PREF_STORE], 'readwrite', async (tx) => {
        const rows: StoredRecord[] = [];
        for (let k = 0; k < MIGRATION_ROW_COUNT; k += 1) {
          rows.push({
            missionId: testId(IDS.MISSION_BASE + MIGRATION_MISSION_SALT + k),
            name: `migrate-me-${k}`,
            namedBy: 'user',
            state: 'live',
            concluded: false,
            tabIds: [],
            createdAt: ISSUED_AT_BASE + k,
            lastActiveAt: ISSUED_AT_BASE + k,
          });
        }
        await tx.table<StoredRecord>(PREF_STORE).putMany(rows);
        return undefined;
      }),
      'migration.seed',
    );
    // ADR-034 invocation contract (runner header): close every other handle to
    // the database BEFORE migrate() — IDB holds a versionchange while sibling
    // connections hold the old version. Measured evidence (PERF_TRACE, E7-T02):
    // keeping the seeding handle open blocked migrate() indefinitely (seed 0.3s,
    // checkpoint 2ms, upgrade open eternal). The checkpoint capability therefore
    // owns its OWN engine lifecycle — open → checkpoint → close — so the
    // upgrade window always carries zero sibling handles.
    // engine.close() is a bare handle release (void), not a Result path.
    await base.close();
    const checkpointEngine = createDexieStorageEngine({ databaseName, indexedDB, idbKeyRange });
    const checkpointJournal = createJournal(checkpointEngine);
    // Measured region: checkpoint + run the synthetic derive-field step v1→v2.
    const runner = createMigrationRunner({
      databaseName,
      indexedDB,
      idbKeyRange,
      checkpoint: async () => {
        const c0 = Date.now();
        perfTrace(`migration.checkpoint.begin #${i}`);
        must(await checkpointEngine.open(), 'migration.checkpoint.open');
        const result = await checkpointJournal.checkpoint();
        await checkpointEngine.close();
        perfTraceWall(`migration.checkpoint.done #${i}`, c0);
        return result;
      },
      versionMap: {
        baseVersion: SCHEMA_VERSION_V1,
        baseStores: SCHEMA_V1,
        steps: [
          {
            from: SCHEMA_VERSION_V1,
            to: SCHEMA_VERSION_V1 + 1,
            stores: {},
            transform: async (db) => {
              const tabs = await db.toArray(PREF_STORE);
              await db.putMany(
                PREF_STORE,
                tabs.map((t) => ({ ...t, [MIGRATION_FIELD]: t['lastActiveAt'] })),
              );
            },
          },
        ],
      },
    });
    perfTraceWall(`migration.seed #${i}`, seedStart);
    const t0 = nowMs();
    const report = must(await runner.migrate(), 'migration.migrate');
    if (i >= cfg.warmup) ms.push(nowMs() - t0);
    if (report.stepsApplied.length !== 1) throw new Error('migration: expected 1 applied step');
    if (!report.checkpointed) throw new Error('migration: checkpoint law not exercised');
  }
  return [latencyRow('dexie', FAMILY, 'migration', MIGRATION_ROW_COUNT, ms)];
};

// ── recovery.duration: boot reconcile over N pending intents (RTO ≤ 5s law) ──────

const recoveryScenario = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  // Pending-intent count rides the scale knob, capped so re-seeding each
  // iteration stays cheap (a boot RESOLVES its backlog — re-measuring one image
  // would measure an empty reconcile after the first iteration).
  const PENDING_CAP = 200;
  const pendingCount = Math.min(scale, PENDING_CAP);
  // Measured (60s-law tuning, E7-T02): each iteration re-seeds + boots and the
  // measured region itself runs 0.5s (100 pending) → 2.1s (200 pending), so the
  // sample count multiplies seconds per grid step. 1 warmup + 2 measured runs
  // (the suite's MIN_MEASURED_AFTER_WARMUP floor) satisfy the RTO ≤ 5s gate —
  // the verdict is a budget bound, and 2 samples bound it identically to 21.
  const RECOVERY_MAX_ITERATIONS = 3;
  const iterations = Math.min(cfg.samples + cfg.warmup, RECOVERY_MAX_ITERATIONS);
  const ms: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const backend = await session.openFresh();
    const ledger = createIntentLedger({ engine: backend.engine, journal: backend.journal });
    let seq = 0;
    const envOf = (intentId: string): EventEnvelope => {
      seq += 1;
      return {
        eventId: testId(
          IDS.EVENT_BASE + RECOVERY_SALT + i * PENDING_CAP + seq,
        ) as EventEnvelope['eventId'],
        hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: ISSUED_AT_BASE + seq },
        type: 'ParkIntentAccepted',
        payload: {
          intentId,
          scope: {
            tabIds: [RECOVERY_BROWSER_TAB_BASE + seq],
            groupStyles: [],
            snapshotId: testId(IDS.SNAPSHOT_BASE + RECOVERY_SALT + i * PENDING_CAP + seq),
          },
          issuedAt: ISSUED_AT_BASE + seq,
        } as EventEnvelope['payload'],
        producerContext: 'sw',
      };
    };
    for (let k = 0; k < pendingCount; k += 1) {
      const intentId = testId(IDS.INTENT_BASE + RECOVERY_SALT + i * PENDING_CAP + k);
      must(
        await ledger.accept({
          intentId: intentId as never,
          cid: testId(IDS.CID_BASE + RECOVERY_SALT + i * PENDING_CAP + k) as never,
          kind: 'ParkTab',
          scope: {
            tabIds: [RECOVERY_BROWSER_TAB_BASE + k],
            groupStyles: [],
            snapshotId: testId(IDS.SNAPSHOT_BASE + RECOVERY_SALT + i * PENDING_CAP + k),
          },
          issuedAt: ISSUED_AT_BASE + k,
          ackEvents: [envOf(intentId)],
        }),
        'recovery.seed',
      );
    }
    const area = createChromeStorageAreaAdapter({ api: createFakeChrome().storage });
    const t0 = nowMs();
    const report = must(
      await runBootSequence({
        reconciler: {
          journal: backend.journal,
          ledger,
          deviceId: DEV_A,
          now: Date.now,
          ids: platformIds,
        },
        area,
        version: '0.0.0-perf',
      }),
      'recovery.boot',
    );
    if (i >= cfg.warmup) ms.push(nowMs() - t0);
    if (report.outcome === 'clean') {
      throw new Error('recovery.duration: expected a reconcile outcome, got clean');
    }
  }
  return [
    latencyRow(session.name, FAMILY, 'recovery.duration', pendingCount, ms, BUDGETS.recoveryRtoMs),
  ];
};

export const maintenanceScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  // Compaction law (L1): the window holds SEALED segments ≤ horizon only — below
  // one full sealed segment the sweep is structurally a no-op, so grid scales at
  // or under the segment cap measure nothing meaningful and are skipped.
  const sweepEligible = scale > SEGMENT_ENTRY_CAP;
  const compaction = sweepEligible
    ? await compactScenario(
        () => session.openFresh(),
        scale,
        cfg,
        session.name,
        'compaction',
        COMPACT_TARGET_SHARE,
      )
    : [];
  const purge = sweepEligible
    ? await compactScenario(
        () => session.openFresh(),
        scale,
        cfg,
        session.name,
        'purge',
        PURGE_DENSE_SHARE,
      )
    : [];
  // PERF_TRACE instrumentation (sanctioned sink in timing.ts): maintenance
  // sub-steps differ by orders of magnitude at CI tiers — measured, never assumed.
  let t0 = Date.now();
  const migration = session.name === 'dexie' ? await migrationScenario(cfg) : [];
  perfTraceWall('maintenance.migration', t0);
  t0 = Date.now();
  const recovery = await recoveryScenario(session, scale, cfg);
  perfTraceWall(`maintenance.recovery @${scale}`, t0);
  return [...compaction, ...purge, ...migration, ...recovery];
};
