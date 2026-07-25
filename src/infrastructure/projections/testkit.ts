// Shared projections fixtures (E2-T03). TEST-ONLY.
import type {
  ProjectionEnginePort,
  ViewDeltaFrame,
} from '@/application/ports/projection-engine.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort, StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, openEngine, testId, uniqueKey } from '@/infrastructure/journal/core/testkit.js';
import { createV1ProjectionEngine } from './index.js';

export { DEV_A, testId, uniqueKey };

const MISSION_ID_FIXTURE_BASE = 11_000;
const TAB_ID_FIXTURE_BASE = 22_000;
const EVENT_ID_FIXTURE_BASE = 33_000;
export const missionId = (n: number): string => testId(MISSION_ID_FIXTURE_BASE + n);
export const tabId = (n: number): string => testId(TAB_ID_FIXTURE_BASE + n);
const WALL = 1_800_000_000_000;

const ev = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  deviceId: DeviceId = DEV_A,
): EventEnvelope => ({
  eventId: testId(EVENT_ID_FIXTURE_BASE + seq) as EventEnvelope['eventId'],
  hlc: { seq, lamport: seq, deviceId, wallClock: WALL + seq },
  type: type as EventEnvelope['type'],
  payload: payload as EventEnvelope['payload'],
  producerContext: 'sw',
});

export const formedEnv = (seq: number, mission: number, tabs: readonly number[]): EventEnvelope =>
  ev(seq, 'MissionFormed', {
    missionId: missionId(mission),
    name: `mission-${mission}`,
    namedBy: 'user',
    tabIds: tabs.map(tabId),
  });

export const renamedEnv = (seq: number, mission: number, name: string): EventEnvelope =>
  ev(seq, 'MissionRenamed', { missionId: missionId(mission), name, namedBy: 'user' });

export const assignedEnv = (seq: number, tab: number, mission: number): EventEnvelope =>
  ev(seq, 'TabAssigned', { tabId: tabId(tab), missionId: missionId(mission) });

export const movedEnv = (seq: number, tab: number, mission: number, from: number): EventEnvelope =>
  ev(seq, 'TabMoved', {
    tabId: tabId(tab),
    missionId: missionId(mission),
    fromMissionId: missionId(from),
  });

export const archivedEnv = (seq: number, mission: number): EventEnvelope =>
  ev(seq, 'MissionArchived', { missionId: missionId(mission) });

export const closedEnv = (seq: number, tab: number, mission?: number): EventEnvelope =>
  ev(seq, 'TabClosedExternal', {
    ledgeTabId: tabId(tab),
    closedAt: WALL + seq,
    ...(mission !== undefined ? { lastMissionId: missionId(mission) } : {}),
  });

export const restoredEnv = (seq: number, tab: number, mission: number): EventEnvelope =>
  ev(seq, 'TrashRestored', { kind: 'tab', id: tabId(tab), resolvedMissionId: missionId(mission) });

export interface ProjectionHarness {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly projections: ProjectionEnginePort;
  readonly frames: ViewDeltaFrame[];
}

/** Engine over a fresh store with delta frames captured (§3.5 publication seam). */
export const makeProjections = async (): Promise<ProjectionHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const frames: ViewDeltaFrame[] = [];
  const projections = createV1ProjectionEngine({
    engine,
    journal,
    onDelta: (f) => frames.push(f),
  });
  return { engine, journal, projections, frames };
};

/** Append valid envelopes to the journal in one call-site (testkit append helper). */
export const seedJournal = async (
  h: ProjectionHarness,
  envelopes: readonly EventEnvelope[],
): Promise<void> => {
  if (envelopes.length === 0) return;
  const r = await h.journal.append(envelopes, { idempotencyKey: uniqueKey('seed') });
  if (!r.ok) throw new Error(`seed append failed: ${r.error.code}`);
};

export const storeSnapshot = async (
  h: ProjectionHarness,
  store: 'missions' | 'recently_closed' | 'sessions',
): Promise<readonly StoredRecord[]> => {
  const r = await h.engine.txn([store], 'readonly', (tx) =>
    tx.table<StoredRecord>(store).toArray(),
  );
  if (!r.ok) throw new Error('snapshot failed');
  // E2-T08: sessions sorts by compound pk (snapshotId,partIndex); others by single pk.
  if (store === 'sessions') {
    return [...r.value].sort(
      (a, b) =>
        String(a['snapshotId'] ?? '').localeCompare(String(b['snapshotId'] ?? '')) ||
        Number(a['partIndex'] ?? 0) - Number(b['partIndex'] ?? 0),
    );
  }
  const pk = store === 'missions' ? 'missionId' : 'entryId';
  return [...r.value].sort((a, b) => String(a[pk] ?? '').localeCompare(String(b[pk] ?? '')));
};
