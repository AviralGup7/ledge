// Shared migration-runner fixtures (E2-T04). TEST-ONLY — colocated with its suites per
// the journal/core/testkit.ts precedent (depcruise writer-concentration follows imports:
// a kit in ops/ pulled into colocated src tests would read as a non-allowlisted writer).
import { readFileSync } from 'node:fs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { StoreName, StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { createDexieStorageEngine } from '@/infrastructure/storage/index.js';
import {
  createMigrationRunner,
  requireReferential,
  requireStoreCounts,
} from '@/infrastructure/storage/index.js';
import type {
  CheckpointCapability,
  MigrationRecord,
  MigrationRunner,
  MigrationRunnerDeps,
  MigrationStep,
  VersionMap,
} from '@/infrastructure/storage/index.js';
import { SCHEMA_V1 } from '../schema/schema.v1.js';

// Fixture constants (named per §2; test-local values, no domain meaning).
const V1 = 1;
const V2 = 2;
const PREF_STORE = 'preferences';
const PREF_SCHEMA = 'key';
const PREF_SEED_KEY = 'uiScale';
const PREF_SEED_VALUE = 1;
const IMPOSSIBLE_PREF_COUNT = 99;
const TABS_STORE = 'tabs';
const MISSIONS_STORE = 'missions';
const TAB_FK = 'missionId';
const MISSION_PK = 'missionId';
const TAB_TOUCH_FIELD = 'lastTouchedAt';
const TAB_ACTIVE_FIELD = 'lastActiveAt';
export const KILL_ERROR_NAME = 'SimulatedKill';
const POISON_ROW_ID = '01POISONPARTIALWRITE0000000';
const POISON_MISSION = '01J0ZK9QW8MISSIONFUTUREV9A';
const ID_PAD = 26;

/** One isolated world per test: fresh in-memory IDB factory + unique database name. */
export interface MigrationWorld {
  readonly dbName: string;
  readonly engine: StorageEnginePort;
  readonly runnerDeps: Pick<MigrationRunnerDeps, 'databaseName' | 'indexedDB' | 'idbKeyRange'>;
}

let worldCounter = 0;

export const makeWorld = (): MigrationWorld => {
  worldCounter += 1;
  const dbName = `ledge-migrations-${worldCounter}`;
  const indexedDB = new IDBFactory() as unknown as globalThis.IDBFactory;
  const idbKeyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange;
  return {
    dbName,
    engine: createDexieStorageEngine({ databaseName: dbName, indexedDB, idbKeyRange }),
    runnerDeps: { databaseName: dbName, indexedDB, idbKeyRange },
  };
};

/** The TEST-ONLY synthetic N→N+1 step the golden fixtures prove (ADR-034 machinery demo). */
const V2_STEP: MigrationStep = {
  from: V1,
  to: V2,
  stores: { [PREF_STORE]: PREF_SCHEMA },
  transform: async (db) => {
    // Pure transform: copies each tab verbatim (unknown fields ride the spread) and
    // derives the new touched marker from existing bytes only — no clock, no entropy.
    const touched = (await db.toArray(TABS_STORE)).map((tab) => ({
      ...tab,
      [TAB_TOUCH_FIELD]: tab[TAB_ACTIVE_FIELD],
    }));
    await db.putMany(TABS_STORE, touched);
    await db.put(PREF_STORE, { key: PREF_SEED_KEY, value: PREF_SEED_VALUE });
  },
  invariants: [
    requireStoreCounts({ [PREF_STORE]: PREF_SEED_VALUE }),
    requireReferential(TABS_STORE, TAB_FK, MISSIONS_STORE, MISSION_PK),
  ],
};

export const TEST_V2_MAP: VersionMap = {
  baseVersion: V1,
  baseStores: SCHEMA_V1,
  steps: [V2_STEP],
};

/** Kill-mid-versionchange: one partial row commits-in-txn wannabe, then the process "dies". */
export const makeCrashMap = (): VersionMap => ({
  baseVersion: V1,
  baseStores: SCHEMA_V1,
  steps: [
    {
      from: V1,
      to: V2,
      stores: { [PREF_STORE]: PREF_SCHEMA },
      transform: async (db) => {
        await db.put(TABS_STORE, {
          ledgeTabId: POISON_ROW_ID,
          missionId: POISON_MISSION,
          state: 'live',
        });
        throw Object.assign(new Error('simulated kill mid-versionchange'), {
          name: KILL_ERROR_NAME,
        });
      },
      invariants: [],
    },
  ],
});

/** Assert-phase breach: transform succeeds, the post-condition law refuses it (ADR-034 3). */
export const makeInvariantBreachMap = (): VersionMap => ({
  baseVersion: V1,
  baseStores: SCHEMA_V1,
  steps: [
    {
      ...V2_STEP,
      invariants: [requireStoreCounts({ [PREF_STORE]: IMPOSSIBLE_PREF_COUNT })],
    },
  ],
});

export interface GoldenFile {
  readonly stores: Readonly<Record<string, readonly StoredRecord[]>>;
}

export const loadGolden = (stem: 'state.v1' | 'expected.v2'): GoldenFile =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../ops/fixtures/migrations/v1-to-v2/${stem}.golden.json`, import.meta.url),
      'utf8',
    ),
  ) as GoldenFile;

export const seedGoldenV1 = async (world: MigrationWorld): Promise<void> => {
  const golden = loadGolden('state.v1');
  const opened = await world.engine.open();
  if (!opened.ok) throw new Error(`engine open failed: ${opened.error.code}`);
  const names = Object.keys(golden.stores) as StoreName[];
  const written = await world.engine.txn(names, 'readwrite', async (tx) => {
    for (const name of names) {
      await tx.table(name).putMany([...(golden.stores[name] ?? [])]);
    }
  });
  if (!written.ok) throw new Error(`seed txn failed: ${written.error.code}`);
};

/** Canonical per-store byte image: row order normalized via stable stringify + sort. */
export const imageOf = (
  image: Readonly<Record<string, readonly MigrationRecord[]>>,
): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(
    Object.entries(image).map(([store, rows]) => [
      store,
      rows.map((r) => stableStringify(r)).sort(),
    ]),
  );

export const goldenImage = (golden: GoldenFile): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(
    Object.entries(golden.stores).map(([store, rows]) => [
      store,
      rows.map((r) => stableStringify(r)).sort(),
    ]),
  );

export const makeRunner = (
  world: MigrationWorld,
  versionMap: VersionMap,
  checkpoint?: CheckpointCapability,
): MigrationRunner =>
  createMigrationRunner({
    ...world.runnerDeps,
    versionMap,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
  });

export const makeJournalPair = (
  world: MigrationWorld,
): { readonly journal: JournalPort; readonly engine: StorageEnginePort } => ({
  journal: createJournal(world.engine),
  engine: world.engine,
});

/** Minimal registry-valid MissionRenamed envelope factory (journal checkpoint fixture feed). */
export const envOf = (seq: number, deviceId: string): EventEnvelope => ({
  eventId: seq.toString().padStart(ID_PAD, '0') as EventEnvelope['eventId'],
  hlc: { seq, lamport: seq, deviceId: deviceId as DeviceId, wallClock: 0 },
  type: 'MissionRenamed',
  payload: {
    missionId: (seq + ID_PAD).toString().padStart(ID_PAD, '0'),
    name: `mission-${seq}`,
    namedBy: 'user',
  } as EventEnvelope['payload'],
  producerContext: 'sw',
});

export const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code} (${r.error.messageKey})`);
  return r.value;
};
