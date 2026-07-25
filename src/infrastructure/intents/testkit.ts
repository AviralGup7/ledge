// Shared intent-ledger fixtures (E2-T02). TEST-ONLY (journal/core/testkit.ts precedent).
import type { AcceptInput, IntentRecord } from '@/application/ports/intent-ledger.port.js';
import type { IntentLedgerPort } from '@/application/ports/intent-ledger.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { Id } from '@/shared-kernel/identity/id.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, openEngine, testId, uniqueKey } from '@/infrastructure/journal/core/testkit.js';
import { createIntentLedger } from './index.js';

export { DEV_A, testId, uniqueKey };

// Fixture id namespaces (disjoint ranges keep eventIds/intentIds/cids distinguishable).
const INTENT_ID_BASE = 40_000;
const CID_BASE = 50_000;
const EVENT_ID_BASE = 60_000;
const SNAPSHOT_ID_BASE = 70_000;
const TAB_ID_BASE = 900;
const ISSUED_AT_BASE = 1_800_000_000_000;

export const intentIdOf = (n: number): Id => testId(INTENT_ID_BASE + n) as Id;
export const cidOf = (n: number): Id => testId(CID_BASE + n) as Id;

const env = (
  seq: number,
  type: 'ParkIntentAccepted' | 'TabsParked' | 'ParkAborted',
  payload: Record<string, unknown>,
): EventEnvelope => ({
  eventId: testId(EVENT_ID_BASE + seq) as EventEnvelope['eventId'],
  hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: 0 },
  type,
  payload: payload as EventEnvelope['payload'],
  producerContext: 'sw',
});

/** Acceptance event with a registry-valid payload (EES §4 ParkIntentAccepted shape). */
export const acceptEnv = (seq: number, intentId: Id, issuedAt: number): EventEnvelope =>
  env(seq, 'ParkIntentAccepted', {
    intentId,
    scope: {
      tabIds: [TAB_ID_BASE + seq],
      groupStyles: [],
      snapshotId: testId(SNAPSHOT_ID_BASE + seq),
    },
    issuedAt,
  });

export const parkedEnv = (seq: number, intentId: Id, secured: number): EventEnvelope =>
  env(seq, 'TabsParked', { intentId, secured });

export const abortedEnv = (seq: number, intentId: Id, liveLeftOpen: number): EventEnvelope =>
  env(seq, 'ParkAborted', { intentId, reason: 'partial-failure', liveLeftOpen });

export const acceptInputOf = (n: number, seq: number): AcceptInput => ({
  intentId: intentIdOf(n),
  cid: cidOf(n),
  kind: 'ParkTab',
  scope: { tabIds: [TAB_ID_BASE + n], groupStyles: [], snapshotId: testId(SNAPSHOT_ID_BASE + n) },
  issuedAt: ISSUED_AT_BASE + n,
  ackEvents: [acceptEnv(seq, intentIdOf(n), ISSUED_AT_BASE + n)],
});

export interface LedgerHarness {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly ledger: IntentLedgerPort;
}

/** Fresh harness on a fresh IDB. Instance death = SW kill (chaos tests re-spawn). */
export const makeLedger = async (): Promise<LedgerHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  return { engine, journal, ledger: createIntentLedger({ engine, journal }) };
};

/** Re-spawn the ledger over the SAME engine (post-kill continuation). */
export const respawnLedger = (h: LedgerHarness): IntentLedgerPort =>
  createIntentLedger({ engine: h.engine, journal: h.journal });

export const allEvents = async (h: LedgerHarness) => {
  const r = await h.journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
  if (!r.ok) throw new Error(`readRange failed: ${r.error.code}`);
  return r.value.events;
};

export const expectRow = async (h: LedgerHarness, intentId: Id): Promise<IntentRecord> => {
  const r = await h.engine.txn(['intents'], 'readonly', (tx) =>
    tx.table<IntentRecord>('intents').get(intentId),
  );
  if (!r.ok) throw new Error('row read failed');
  if (r.value === undefined) throw new Error(`intent row ${intentId} missing`);
  return r.value;
};
