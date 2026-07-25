// Shared journal/storage test fixtures (E1-T10+). TEST-ONLY: imported only by this
// module's *.test.ts suites (never reachable from entrypoints, so never bundled).
// Lives inside src (not ops/) because depcruise's writer-concentration law (ADR-005)
// follows imports: a kit in ops/tests pulled into colocated src tests would read as a
// non-allowlisted writer of journal/storage. Deterministic in-memory engines + envelope
// factories for the durable-write family.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDexieStorageEngine } from '@/infrastructure/storage/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';

export const DEV_A = '0TESTDEVICE000000000000000' as DeviceId;
export const DEV_B = '0TESTDEVICE000000000000001' as DeviceId;

// Fixture constants (named per §2; test-local values, no domain meaning).
const MISSION_ID_SALT = 9000;
const WINDOW_ID_BASE = 100;
const WALL_BASE_MS = 1_785_000_000_000;
const ID_PAD = 26; // canonical Id length (ID_LENGTH in the kernel)
const HEX_RADIX = 16;

/** 26-char Crockford-valid deterministic Id (test-local; the kernel factory is the prod one).
 *  Uppercase per the canonical isId pattern (lowercase is correctly rejected by the kernel). */
export const testId = (n: number): string =>
  n.toString(HEX_RADIX).padStart(ID_PAD, '0').toUpperCase();

export type EnvType = 'MissionRenamed' | 'WindowClosedExternal' | 'SettingsChanged';

export const makeEnv = (
  seq: number,
  lamport: number,
  deviceId: DeviceId = DEV_A,
  type: EnvType = 'MissionRenamed',
): EventEnvelope => {
  const payload =
    type === 'MissionRenamed'
      ? { missionId: testId(MISSION_ID_SALT + seq), name: `mission-${seq}`, namedBy: 'user' }
      : type === 'WindowClosedExternal'
        ? { windowId: seq + WINDOW_ID_BASE, closedAt: WALL_BASE_MS + seq }
        : { key: `k-${seq}`, value: seq, schemaV: 1 };
  return {
    eventId: testId(seq) as EventEnvelope['eventId'],
    hlc: { seq, lamport, deviceId, wallClock: 0 },
    type,
    payload,
    producerContext: 'sw',
  };
};

export const makeEngine = (): StorageEnginePort =>
  createDexieStorageEngine({
    indexedDB: new IDBFactory() as unknown as globalThis.IDBFactory,
    idbKeyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
  });

export const openEngine = async (): Promise<StorageEnginePort> => {
  const engine = makeEngine();
  const r = await engine.open();
  if (!r.ok) throw new Error(`engine open failed: ${r.error.code}`);
  return engine;
};

export const makeJournal = async (): Promise<{
  engine: StorageEnginePort;
  journal: JournalPort;
}> => {
  const engine = await openEngine();
  return { engine, journal: createJournal(engine) };
};

// Each test owns a fresh in-memory engine, so a per-process counter is sufficient —
// keys never share a database.
let keyCounter = 0;
export const uniqueKey = (scope = 'batch'): string => `${scope}-${++keyCounter}`;
