// E7-T02 · Lifecycle scenarios — the M1-exit evidence rows:
//   wake (SW cold wake → hub ready, budget ≤200ms p95, EES §7.1)
//   park.ack (Park(100 tabs) durable ack, budget ≤500ms p95, EES §7.1)
// plus boot cold/warm, intent-ack latency, and the boot memory signature.
// Wake = compose graph → boot (open+identity+storage-law) → runBootSequence
// (marker classify + boot reconcile over the real corpus) — the full §6.2 path.
import { createChromeStorageAreaAdapter } from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import { createIntentLedger } from '@/infrastructure/intents/index.js';
import { createProjectionEngine } from '@/infrastructure/projections/index.js';
import { V1_PROJECTORS } from '@/infrastructure/projections/index.js';
import { runBootSequence } from '@/infrastructure/recovery/index.js';
import { buildSnapshotPayload } from '@/infrastructure/snapshots/index.js';
import { composeBackgroundGraph } from '@/roots/bg-root.js';
import { platformIds } from '@/shared-kernel/identity/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { PerfConfig } from '../config.js';
import { BUDGETS, SNAPSHOT_TAB_COUNT } from '../config.js';
import type { Backend, BackendSession } from '../backends.js';
import {
  DEV_A,
  IDS,
  PERF_INSTALL_ID,
  makeGroupStyles,
  makeJournalCorpus,
  makeTabRecordIds,
  testId,
} from '../corpora.js';
import { appendCorpus, latencyRow, memoryRow, must } from './shared.js';
import { measureMemory, nowMs } from '../timing.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'lifecycle';

const SEED = 7_201;
const BUILD_VERSION = '0.0.0-perf';
const ISSUED_AT_BASE = 1_800_000_000_000;
const BROWSER_TAB_BASE = 10_000;
const PARK_GROUP_COUNT = 3;

/** Park-family id salts (nested inside the IDS namespaces of corpora.ts). */
const PARK_EVENT_SALT = 50_000;
const PARK_SCOPE_SALT = 10_000;

type Row = ScenarioResult;

/** Live seq head of the scenario's shared image (idempotent-start law: envelopes
 *  must chain from the durable head, whatever earlier scenarios left behind). */
const headOf = async (backend: Backend): Promise<number> =>
  must(await backend.journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'headOf').durableThrough;

/** One full SW wake on an already-open engine handle (shared by wake/warm rows). */
const wakeOnce = async (rawEngine: () => StorageEnginePort): Promise<number> => {
  const t0 = nowMs();
  const graph = composeBackgroundGraph({ storage: rawEngine() });
  const boot = must(await graph.boot, 'graph.boot');
  const area = createChromeStorageAreaAdapter({ api: createFakeChrome().storage });
  const ledger = createIntentLedger({ engine: graph.storage, journal: graph.journal });
  const projections = createProjectionEngine({
    engine: graph.storage,
    journal: graph.journal,
    projectors: V1_PROJECTORS,
  });
  const report = must(
    await runBootSequence({
      reconciler: {
        journal: graph.journal,
        ledger,
        projections,
        deviceId: boot.deviceId,
        now: Date.now,
        ids: platformIds,
      },
      area,
      version: BUILD_VERSION,
    }),
    'runBootSequence',
  );
  void report;
  return nowMs() - t0;
};

// ── boot.cold: brand-new database per iteration (identity provisioning included) ──

const bootCold = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly Row[]> => {
  const ms: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const cold = await session.openFresh();
    const t0 = nowMs();
    const graph = composeBackgroundGraph({ storage: cold.engine });
    must(await graph.boot, 'boot.cold');
    ms.push(nowMs() - t0);
  }
  return [latencyRow(session.name, FAMILY, 'boot.cold', scale, ms)];
};

// ── boot.warm + wake: seeded image (corpus + identity), reopen per iteration ─────

const bootWarmAndWake = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly Row[]> => {
  const backend = await session.open();
  const corpus = makeJournalCorpus(scale, SEED, PERF_INSTALL_ID);
  // Seed journal bytes + the install-identity row (warm = a real prior session).
  await appendCorpus(backend.journal, corpus, `perf-warm-${scale}`);
  await stampIdentity(backend);
  // Steady-state wake law: checkpoints are kept fresh by maintenance windows
  // (E2-T01 scanTail law), so the faithful wake walks the post-checkpoint tail.
  must(await backend.journal.checkpoint(), 'warm.checkpoint');

  const bootMs: number[] = [];
  const wakeMs: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    // boot.warm = engine open + identity read-through over the seeded image.
    const t0 = nowMs();
    const raw = session.rawFor(backend);
    const graph = composeBackgroundGraph({ storage: raw });
    must(await graph.boot, 'boot.warm');
    if (i >= cfg.warmup) bootMs.push(nowMs() - t0);
    // wake = full hub-ready path on a fresh handle over the same image.
    const w = await wakeOnce(() => session.rawFor(backend));
    if (i >= cfg.warmup) wakeMs.push(w);
  }
  return [
    latencyRow(session.name, FAMILY, 'boot.warm', scale, bootMs),
    latencyRow(session.name, FAMILY, 'wake', scale, wakeMs, BUDGETS.wakeP95Ms),
  ];
};

const stampIdentity = async (backend: Backend): Promise<void> => {
  must(
    await backend.engine.txn(['meta'], 'readwrite', async (tx) => {
      await tx.table('meta').put({ key: 'deviceId', value: PERF_INSTALL_ID as string });
      return undefined;
    }),
    'stampIdentity',
  );
};

// ── ack: the intent-ledger durability hinge (ParkIntentAccepted, 1-tab scope) ─────

const ackScenario = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly Row[]> => {
  const backend = await session.open();
  let seq = await headOf(backend);
  const backendName = backend.name;
  const envOf = (intentId: string, issuedAt: number): EventEnvelope => {
    seq += 1;
    return {
      eventId: testId(IDS.EVENT_BASE + seq) as EventEnvelope['eventId'],
      hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: issuedAt },
      type: 'ParkIntentAccepted',
      payload: {
        intentId,
        scope: {
          tabIds: [BROWSER_TAB_BASE + seq],
          groupStyles: [],
          snapshotId: testId(IDS.SNAPSHOT_BASE + seq),
        },
        issuedAt,
      } as EventEnvelope['payload'],
      producerContext: 'sw',
    };
  };
  const ledger = createIntentLedger({ engine: backend.engine, journal: backend.journal });
  const ms: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const intentId = testId(IDS.INTENT_BASE + i + 1);
    const issuedAt = ISSUED_AT_BASE + i;
    const t0 = nowMs();
    must(
      await ledger.accept({
        intentId: intentId as never,
        cid: testId(IDS.CID_BASE + i + 1) as never,
        kind: 'ParkTab',
        scope: {
          tabIds: [BROWSER_TAB_BASE + i],
          groupStyles: [],
          snapshotId: testId(IDS.SNAPSHOT_BASE + i),
        },
        issuedAt,
        ackEvents: [envOf(intentId, issuedAt)],
      }),
      'ack.accept',
    );
    ms.push(nowMs() - t0);
  }
  return [latencyRow(backendName, FAMILY, 'ack', scale, ms)];
};

// ── park.ack(100): snapshot build + SnapshotTaken append + hinged acceptance ──────

const parkScenario = async (
  session: BackendSession,
  scaleIgnored: number,
  cfg: PerfConfig,
): Promise<readonly Row[]> => {
  const backend = await session.open();
  let seq = await headOf(backend);
  const nextEnv = (
    type: EventEnvelope['type'],
    payload: Record<string, unknown>,
  ): EventEnvelope => {
    seq += 1;
    return {
      eventId: testId(IDS.EVENT_BASE + PARK_EVENT_SALT + seq) as EventEnvelope['eventId'],
      hlc: { seq, lamport: seq, deviceId: DEV_A as DeviceId, wallClock: ISSUED_AT_BASE + seq },
      type,
      payload: payload as EventEnvelope['payload'],
      producerContext: 'sw',
    };
  };
  const ledger = createIntentLedger({ engine: backend.engine, journal: backend.journal });
  const ms: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const tabs = makeTabRecordIds(SNAPSHOT_TAB_COUNT);
    const snapshotId = testId(IDS.SNAPSHOT_BASE + PARK_SCOPE_SALT + i);
    const missionId = testId(IDS.MISSION_BASE + i);
    const issuedAt = ISSUED_AT_BASE + i;
    const t0 = nowMs();
    const built = must(
      buildSnapshotPayload({
        snapshotId: snapshotId as never,
        missionId: missionId as never,
        tabRecordIds: tabs as never,
        groupStyles: makeGroupStyles(PARK_GROUP_COUNT, tabs),
        takenAt: issuedAt,
        trigger: 'park',
      }),
      'park.buildSnapshot',
    );
    must(
      await backend.journal.append([nextEnv('SnapshotTaken', { ...built.payload })], {
        idempotencyKey: `perf-park-snap-${i}`,
      }),
      'park.appendSnapshot',
    );
    const intentId = testId(IDS.INTENT_BASE + PARK_SCOPE_SALT + i);
    must(
      await ledger.accept({
        intentId: intentId as never,
        cid: testId(IDS.CID_BASE + PARK_SCOPE_SALT + i) as never,
        kind: 'ParkWindow',
        scope: {
          tabIds: tabs.map((_, k) => BROWSER_TAB_BASE + k),
          groupStyles: makeGroupStyles(PARK_GROUP_COUNT, tabs),
          snapshotId,
        },
        issuedAt,
        ackEvents: [
          nextEnv('ParkIntentAccepted', {
            intentId,
            scope: {
              tabIds: tabs.map((_, k) => BROWSER_TAB_BASE + k),
              groupStyles: makeGroupStyles(PARK_GROUP_COUNT, tabs),
              snapshotId,
            },
            issuedAt,
          }),
        ],
      }),
      'park.accept',
    );
    ms.push(nowMs() - t0);
  }
  return [
    latencyRow(backend.name, FAMILY, 'park.ack', SNAPSHOT_TAB_COUNT, ms, BUDGETS.parkAckP95Ms),
  ];
};

const bootMemory = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const peaks: number[] = [];
  const steadies: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const sig = await measureMemory(async () => {
      const cold = await session.openFresh();
      const graph = composeBackgroundGraph({ storage: cold.engine });
      must(await graph.boot, 'boot.memory');
    });
    peaks.push(sig.peakMB);
    steadies.push(sig.steadyMB);
  }
  return [
    memoryRow(session.name, FAMILY, 'memory.boot.peak', scale, peaks),
    memoryRow(session.name, FAMILY, 'memory.boot.steady', scale, steadies),
  ];
};

export const lifecycleScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const cold = await bootCold(session, scale, cfg);
  const warmWake = await bootWarmAndWake(session, scale, cfg);
  const ack = await ackScenario(session, scale, cfg);
  const park = await parkScenario(session, scale, cfg);
  const mem = await bootMemory(session, scale, cfg);
  return [...cold, ...warmWake, ...ack, ...park, ...mem];
};
