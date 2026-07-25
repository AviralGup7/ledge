// E2-T08 snapshot fixtures (TEST-ONLY — journal/core/testkit.ts precedent).
// One world = memory storage engine + real journal + real V1 projection engine
// (sessions view registered) with deterministic ids/time; envelope factory
// chains stream seqs (journal contiguity law). Snapshot drafts are built
// through the REAL builder and appended through the REAL journal, so fixture
// streams are indistinguishable from park-flow output; torn stores are made
// by writing rows directly and simply never writing the rest.
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { Id, IdGenerator } from '@/shared-kernel/identity/index.js';
import type { JournalPort, ReadRangeResult } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { ProjectorDef } from '@/application/ports/projection-engine.port.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createProjectionEngine, V1_PROJECTORS } from '@/infrastructure/projections/index.js';
import { DEV_A, openEngine, testId, uniqueKey } from '@/infrastructure/journal/core/testkit.js';
import { buildSnapshotPayload } from './builder.js';
import { probeSnapshotIntegrity } from './probe.js';
import type {
  GroupStyle,
  SessionPartRow,
  SnapshotInput,
  SnapshotIntegrityReport,
} from './types.js';

export { DEV_A, testId };

const EVENT_ID_BASE = 800_000;
const TAB_BASE = 810_000;
const MISSION_BASE = 820_000;
const SNAP_BASE = 830_000;
export const SNAP_WALL_BASE = 1_950_000_000_000;

export const snapshotTabId = (n: number): Id => testId(TAB_BASE + n) as Id;
export const snapshotMissionId = (n: number): Id => testId(MISSION_BASE + n) as Id;
export const snapshotIdOf = (n: number): Id => testId(SNAP_BASE + n) as Id;

let counter = 0;
const freshId = (): Id => {
  counter += 1;
  return testId(EVENT_ID_BASE + counter) as Id;
};

export const styleOf = (
  groupId: number,
  tabIds: readonly Id[],
  over: Partial<GroupStyle> = {},
): GroupStyle => ({
  groupId,
  name: `group-${groupId}`,
  color: 'blue',
  collapsed: false,
  tabOrder: tabIds as readonly string[],
  ...over,
});

export interface SnapshotWorld {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly projections: ProjectionEnginePort;
  seq: number;
  /** Envelope factory chaining stream seqs (journal contiguity law enforced). */
  readonly env: (type: EventEnvelope['type'], payload: Record<string, unknown>) => EventEnvelope;
  /** Append a SnapshotTaken event for `input` (builder + journal, full path). */
  readonly takeSnapshot: (input: SnapshotInput) => Promise<void>;
  readonly append: (envelopes: readonly EventEnvelope[]) => Promise<void>;
  readonly readAll: () => Promise<ReadRangeResult['events']>;
  /** All sessions-store rows (primary walk). */
  readonly partRows: () => Promise<readonly SessionPartRow[]>;
  /** Direct row write/remove for torn-store chaos (bypasses the projector). */
  readonly putRow: (row: SessionPartRow) => Promise<void>;
  readonly deleteRow: (snapshotId: string, partIndex: number) => Promise<void>;
  readonly probe: () => Promise<Result<SnapshotIntegrityReport, LedgeError>>;
  readonly applyProjections: () => Promise<number>;
}

const unwrap = <T>(r: Result<T, LedgeError>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
  return r.value;
};

export interface SnapshotWorldOptions {
  /** Chaos seam: override the projector set (e.g. sabotaged SessionsView). */
  readonly projectors?: readonly ProjectorDef[] | undefined;
}

export const makeSnapshotWorld = async (
  options: SnapshotWorldOptions = {},
): Promise<SnapshotWorld> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const projections = createProjectionEngine({
    engine,
    journal,
    projectors: options.projectors ?? V1_PROJECTORS,
    onDelta: () => undefined,
  });
  const world: SnapshotWorld = {
    engine,
    journal,
    projections,
    seq: 0,
    env: (type, payload) => {
      world.seq += 1;
      return {
        eventId: freshId(),
        hlc: { seq: world.seq, lamport: world.seq, deviceId: DEV_A, wallClock: 0 },
        type,
        payload: payload as EventEnvelope['payload'],
        producerContext: 'sw',
      };
    },
    takeSnapshot: async (input) => {
      const built = unwrap(buildSnapshotPayload(input), 'builder rejected fixture');
      await world.append([world.env('SnapshotTaken', { ...built.payload })]);
    },
    append: async (envelopes) => {
      if (envelopes.length === 0) return;
      const r = await journal.append(envelopes, { idempotencyKey: uniqueKey('snap-fixture') });
      if (!r.ok) throw new Error(`fixture append failed: ${r.error.code}`);
    },
    readAll: async () =>
      unwrap(await journal.readRange({ deviceId: DEV_A, fromSeq: 0 }), 'readRange').events,
    partRows: async () =>
      unwrap(
        await engine.txn(['sessions'], 'readonly', (tx) =>
          tx.table<SessionPartRow>('sessions').toArray(),
        ),
        'sessions toArray',
      ),
    putRow: async (row) => {
      unwrap(
        await engine.txn(['sessions'], 'readwrite', async (tx) => {
          await tx.table<SessionPartRow>('sessions').put(row);
        }),
        'putRow',
      );
    },
    deleteRow: async (snapshotId, partIndex) => {
      unwrap(
        await engine.txn(['sessions'], 'readwrite', async (tx) => {
          await tx.table<SessionPartRow>('sessions').delete([snapshotId, partIndex]);
        }),
        'deleteRow',
      );
    },
    probe: () => probeSnapshotIntegrity({ storage: engine, journal, deviceId: DEV_A }),
    applyProjections: async () =>
      unwrap(await projections.applyFromJournal(DEV_A), 'applyFromJournal').applied,
  };
  return world;
};

/** Deterministic ids generator (engine/reconciler pattern). */
export const snapshotIds = (): IdGenerator => ({
  nextId: () => freshId(),
  timeOf: () => 0,
});
