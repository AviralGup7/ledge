// E7-T02 · Snapshot scenarios — generation (builder + SnapshotTaken append +
// sessions projection) and restore (part rows → payload view → integrity probe)
// at the mission's tab-count scales. EES-R5 chunking rides: 500 refs/part.
import { createProjectionEngine } from '@/infrastructure/projections/index.js';
import { V1_PROJECTORS } from '@/infrastructure/projections/index.js';
import {
  buildSnapshotPayload,
  probeSnapshotIntegrity,
  readSnapshotPayload,
} from '@/infrastructure/snapshots/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { PerfConfig } from '../config.js';
import type { BackendSession } from '../backends.js';
import { DEV_A, IDS, makeGroupStyles, makeTabRecordIds, testId } from '../corpora.js';
import { latencyRow, must } from './shared.js';
import { nowMs } from '../timing.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'snapshots';

const WALL_BASE = 1_950_000_000_000;

/** Snapshot workload id salts (disjoint from other families). */
const SNAP_EVENT_SALT = 100_000;
const SNAP_ROW_SALT = 200_000;
const GROUPS_PER_100_TABS = 5;
/** Denominator translating tab count into "hundreds of tabs" for group math. */
const TABS_PER_HUNDRED = 100;
const TABS_PER_GROUP = 20;

/** Snapshot workloads scale by TAB count (100/1k/10k/50k tabs), not event count. */
export const snapshotScenarios = async (
  session: BackendSession,
  tabCount: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const out: ScenarioResult[] = [];
  const backend = await session.open();
  let seq = 0;
  const envOf = (payload: Record<string, unknown>): EventEnvelope => {
    seq += 1;
    return {
      eventId: testId(IDS.EVENT_BASE + SNAP_EVENT_SALT + seq) as EventEnvelope['eventId'],
      hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: WALL_BASE + seq },
      type: 'SnapshotTaken',
      payload: payload as EventEnvelope['payload'],
      producerContext: 'sw',
    };
  };
  const projections = createProjectionEngine({
    engine: backend.engine,
    journal: backend.journal,
    projectors: V1_PROJECTORS,
  });

  const groupsOf = (tabs: readonly string[]) => {
    const groupCount = Math.max(
      1,
      Math.round((tabs.length / TABS_PER_HUNDRED) * GROUPS_PER_100_TABS),
    );
    return makeGroupStyles(groupCount, tabs).map((g, i) => ({
      ...g,
      tabOrder: tabs.slice(i * TABS_PER_GROUP, i * TABS_PER_GROUP + TABS_PER_GROUP),
    }));
  };

  // ── generate: build payload + append + project sessions rows ────────────────
  const genMs: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const tabs = makeTabRecordIds(tabCount);
    const t0 = nowMs();
    const built = must(
      buildSnapshotPayload({
        snapshotId: testId(IDS.SNAPSHOT_BASE + SNAP_ROW_SALT + i) as never,
        missionId: testId(IDS.MISSION_BASE + 1) as never,
        tabRecordIds: tabs as never,
        groupStyles: groupsOf(tabs),
        takenAt: WALL_BASE + i,
        trigger: 'auto',
      }),
      'snapshot.build',
    );
    must(
      await backend.journal.append([envOf({ ...built.payload })], {
        idempotencyKey: `perf-snap-${tabCount}-${i}`,
      }),
      'snapshot.append',
    );
    must(await projections.applyFromJournal(DEV_A), 'snapshot.applyFromJournal');
    genMs.push(nowMs() - t0);
  }
  out.push(latencyRow(backend.name, FAMILY, 'generate', tabCount, genMs));

  // ── restore: part rows assembled + last SnapshotTaken payload validated +
  //    the journal↔store exactness probe (the restore path's verification law) ──
  const lastSnapshotId = testId(IDS.SNAPSHOT_BASE + SNAP_ROW_SALT + cfg.samples - 1);
  const head = seq;
  const restoreMs: number[] = [];
  for (let i = 0; i < cfg.samples; i += 1) {
    const t0 = nowMs();
    const rows = must(
      await backend.engine.txn(['sessions'], 'readonly', (tx) => tx.table('sessions').toArray()),
      'snapshot.restore.read',
    );
    const mine = rows.filter((r) => r['snapshotId'] === lastSnapshotId);
    if (mine.length === 0) throw new Error('snapshot.restore: no part rows found');
    mine.sort((a, b) => Number(a['partIndex']) - Number(b['partIndex']));
    const refs = mine.flatMap((r) => (Array.isArray(r['tabRecordIds']) ? r['tabRecordIds'] : []));
    if (refs.length !== tabCount) {
      throw new Error(`snapshot.restore: assembled ${refs.length} refs, expected ${tabCount}`);
    }
    const tail = must(
      await backend.journal.readRange({ deviceId: DEV_A, fromSeq: head, toSeq: head }),
      'snapshot.restore.tail',
    );
    const payloadView = readSnapshotPayload(tail.events[0]?.envelope.payload);
    if (payloadView === null) throw new Error('snapshot.restore: unreadable tail payload');
    const probe = must(
      await probeSnapshotIntegrity({
        storage: backend.engine,
        journal: backend.journal,
        deviceId: DEV_A,
      }),
      'snapshot.probe',
    );
    if (probe.issues.length > 0) {
      throw new Error(`snapshot.restore: probe found ${probe.issues.length} issues`);
    }
    restoreMs.push(nowMs() - t0);
  }
  out.push(latencyRow(backend.name, FAMILY, 'restore', tabCount, restoreMs));
  return out;
};
