// E2-T06 reconciler fixtures (TEST-ONLY — journal/core/testkit.ts precedent).
// One world = memory storage engine + real journal + real ledger (+ optional real
// projections engine) + reconciler deps with deterministic ids/time. Envelopes are
// registry-valid and chain seqs via a ticker (journal contiguity law), so fixture
// streams are indistinguishable from executor-written ones — torn states are made
// by writing the DURABLE half of a flow and simply never writing the rest.
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { Id, IdGenerator } from '@/shared-kernel/identity/index.js';
import type { IntentLedgerPort, IntentRecord } from '@/application/ports/intent-ledger.port.js';
import type { JournalPort, ReadRangeResult } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';
import type { BootSignal } from '../marker/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError } from '@/shared-kernel/result/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createIntentLedger } from '@/infrastructure/intents/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { DEV_A, openEngine, testId, uniqueKey } from '@/infrastructure/journal/core/testkit.js';
import type { IntentDisposition, ReconcilerDeps } from './types.js';
import { reconcileBoot } from './reconciler.js';

export { DEV_A, testId, uniqueKey };

const EVENT_ID_BASE = 600_000;
const LEDGE_TAB_BASE = 700_000;
const INTENT_ID_BASE = 740_000;
const CID_BASE = 750_000;
const MISSION_ID_BASE = 760_000;
const WALL_BASE = 1_850_000_000_000;
const BROWSER_TAB_BASE = 900;
const CLOSED_AT_OFFSET = 1_000;

export const browserTabId = (n: number): number => BROWSER_TAB_BASE + n;
export const ledgeTabId = (n: number): Id => testId(LEDGE_TAB_BASE + n) as Id;
export const intentId = (n: number): Id => testId(INTENT_ID_BASE + n) as Id;
export const cid = (n: number): Id => testId(CID_BASE + n) as Id;
export const missionId = (n: number): Id => testId(MISSION_ID_BASE + n) as Id;

let counter = 0;
const freshId = (): Id => {
  counter += 1;
  return testId(EVENT_ID_BASE + counter) as Id;
};

const deterministicIds = (): IdGenerator => ({
  nextId: () => freshId(),
  timeOf: () => 0,
});

export interface ReconcileWorld {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly ledger: IntentLedgerPort;
  readonly projections: ProjectionEnginePort;
  readonly deps: ReconcilerDeps;
  /** Envelope factory chaining stream seqs (journal contiguity law enforced). */
  readonly env: (type: EventEnvelope['type'], payload: Record<string, unknown>) => EventEnvelope;
  /** Append fixture envelopes through the real journal (validated, hinged keys). */
  readonly append: (envelopes: readonly EventEnvelope[]) => Promise<void>;
  readonly readAll: () => Promise<ReadRangeResult['events']>;
  readonly row: (id: Id) => Promise<IntentRecord>;
  readonly nowTick: () => number;
  seq: number;
}

export interface ReconcileWorldOptions {
  /**
   * Pre-opened engine override (E2-T09 chaos seam): the harness drives points
   * through a FAULT-INJECTING engine proxy; suites keep the default in-memory.
   * Must already be open (same makeWorld law: this kit never opens what it
   * didn't create, and never closes what it was handed).
   */
  readonly engine?: StorageEnginePort;
}

export const makeWorld = async (options: ReconcileWorldOptions = {}): Promise<ReconcileWorld> => {
  const engine = options.engine ?? (await openEngine());
  const journal = createJournal(engine);
  const ledger = createIntentLedger({ engine, journal });
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  let wall = WALL_BASE;
  const nowTick = (): number => {
    wall += 1;
    return wall;
  };
  const world: ReconcileWorld = {
    engine,
    journal,
    ledger,
    projections,
    deps: {
      journal,
      ledger,
      projections,
      deviceId: DEV_A,
      now: nowTick,
      ids: deterministicIds(),
    },
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
    append: async (envelopes) => {
      if (envelopes.length === 0) return;
      const r = await journal.append(envelopes, { idempotencyKey: uniqueKey('fixture') });
      if (!r.ok) throw new Error(`fixture append failed: ${r.error.code} ${r.error.messageKey}`);
    },
    readAll: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 0 });
      if (!r.ok) throw new Error(`readRange failed: ${r.error.code}`);
      return r.value.events;
    },
    row: async (id) => {
      const r = await engine.txn(['intents'], 'readonly', (tx) =>
        tx.table<IntentRecord>('intents').get(id),
      );
      if (!r.ok) throw new Error('row read failed');
      if (r.value === undefined) throw new Error(`intent row ${id} missing`);
      return r.value;
    },
    nowTick,
    seq: 0,
  };
  return world;
};

// ── Fixture event minting (registry-valid payloads, §4 shapes) ───────────────

export const tabObserved = (w: ReconcileWorld, n: number): EventEnvelope =>
  w.env('TabObserved', {
    ledgeTabId: ledgeTabId(n),
    browserTabId: browserTabId(n),
    windowId: 1,
    url: `https://t${n}.example/x`,
    urlCanon: `https://t${n}.example/x`,
    canonRulesV: 1,
    title: `tab ${n}`,
    domain: `t${n}.example`,
    ts: WALL_BASE + n,
  });

export const tabClosedExternal = (w: ReconcileWorld, n: number): EventEnvelope =>
  w.env('TabClosedExternal', {
    ledgeTabId: ledgeTabId(n),
    closedAt: WALL_BASE + CLOSED_AT_OFFSET + n,
  });

export const tabsParked = (w: ReconcileWorld, id: Id, secured: number): EventEnvelope =>
  w.env('TabsParked', { intentId: id, secured });

export const parkAborted = (w: ReconcileWorld, id: Id, liveLeftOpen: number): EventEnvelope =>
  w.env('ParkAborted', { intentId: id, reason: 'partial-failure', liveLeftOpen });

/**
 * Accept an intent through the real ledger (hinged accept: ack event + row + cid in
 * one txn). The ack envelope uses the park-family catalog shape for EVERY kind —
 * the shape is what the ledger commits (§4 has no acceptance row for delete/undo
 * families yet); trail scans only consult policy-curated TERMINAL types, so the
 * neutral ack never contaminates evidence classification.
 */
export const acceptIntent = async (
  w: ReconcileWorld,
  n: number,
  kind: string,
  scope: unknown,
): Promise<Id> => {
  const id = intentId(n);
  const ack = w.env('ParkIntentAccepted', { intentId: id, scope, issuedAt: WALL_BASE + n });
  const r = await w.ledger.accept({
    intentId: id,
    cid: cid(n),
    kind,
    scope,
    issuedAt: WALL_BASE + n,
    ackEvents: [ack],
  });
  if (!r.ok) throw new Error(`accept failed: ${r.error.code} ${r.error.messageKey}`);
  return id;
};

/** Observe a live tab then close it externally (the R2 evidence pair). */
export const observeThenClose = async (w: ReconcileWorld, ns: readonly number[]): Promise<void> => {
  for (const n of ns) await w.append([tabObserved(w, n)]);
  for (const n of ns) await w.append([tabClosedExternal(w, n)]);
};

export interface Sabotage {
  readonly scanTailFails: boolean;
  /** Mutable holder — the first append whose batch mentions this intentId fails once. */
  readonly failAppendForIntent: { current: Id | null };
  readonly pendingFails: boolean;
}

const stalled = <T>(raw: string): Result<T, LedgeError> =>
  err(ledgeError('E_JOURNAL_INTEGRITY', { raw }));

/** Wrap a world's deps with journal/ledger sabotage knobs (conservative-posture tests). */
export const withSabotage = (w: ReconcileWorld, sabotage: Sabotage): ReconcilerDeps => {
  const journal: JournalPort = {
    ...w.journal,
    scanTail: () =>
      sabotage.scanTailFails
        ? Promise.resolve(stalled('test-scan-tail-stall'))
        : w.journal.scanTail(),
  };
  // Ledger-seam sabotage: terminal-write refusals surface HERE (the ledger closed
  // over the real journal at construction; a stalled settle is what the reconciler
  // would observe from any deeper journal failure — same Result, same law).
  const ledger: IntentLedgerPort = {
    ...w.ledger,
    pending: () =>
      sabotage.pendingFails ? Promise.resolve(stalled('test-pending-stall')) : w.ledger.pending(),
    complete: (intentIdArg, events, resolvedAt) => {
      if (sabotage.failAppendForIntent.current === intentIdArg) {
        sabotage.failAppendForIntent.current = null;
        return Promise.resolve(stalled('test-append-stall'));
      }
      return w.ledger.complete(intentIdArg, events, resolvedAt);
    },
    abort: (intentIdArg, events, resolvedAt) => {
      if (sabotage.failAppendForIntent.current === intentIdArg) {
        sabotage.failAppendForIntent.current = null;
        return Promise.resolve(stalled('test-append-stall'));
      }
      return w.ledger.abort(intentIdArg, events, resolvedAt);
    },
  };
  return { ...w.deps, journal, ledger };
};

/**
 * Canned crash-marker signal for reconcile-focused fixtures (E2-T07 added the
 * signal as an explicit reconcileBoot input). Worlds that never exercise the
 * marker lifecycle simulate a plain SW recycle: warm, invisible, copyKey null.
 */
export const warmBootSignal = (): BootSignal => ({
  cause: 'warm-recycle',
  abnormal: false,
  evidence: {
    aliveSeen: true,
    installReason: 'install',
    installedVersion: '0.0.0-test',
    lastBootVersion: '0.0.0-test',
    installedAt: WALL_BASE,
    lastBootAt: WALL_BASE,
  },
  gaps: [],
});

export const reconcile = (w: ReconcileWorld, deps?: ReconcilerDeps, signal?: BootSignal) =>
  reconcileBoot(deps ?? w.deps, signal ?? warmBootSignal());

/**
 * Kill points THIS suite owns in ops/chaos/points.txt (flow-partition law:
 * boot.* points belong to the marker suite, compact.* to journal/compact
 * (E2-T11) — the partition is constitution-
 * asserted across both suites so an orphan file line or a phantom fixture
 * fails CI, from either side).
 */
export const RECONCILER_KILL_POINTS: readonly string[] = [
  'park.commit-intent.before',
  'park.commit-intent.after',
  'park.browser-close.mid-batch',
  'park.commit-completion.before',
  'park.commit-completion.after',
  'resume.intent.after',
  'resume.window-create.mid',
  'resume.tab-create.mid-batch',
  'delete.commit.before',
  'delete.commit.after',
  'undo.apply.mid',
  'import.commit.chunk-mid',
  'import.commit.before-final-marker',
  'trash.sweep.mid',
  'archive.conclude.mid.artifact-write',
];

// ---------------------------------------------------------------------------
// E2-T09 · kill-point fixture catalog — the CANONICAL point ⇒ (torn-state
// setup, resolution expectation) binding, lifted here from the chaos suite so
// the central harness driver (ops/chaos) executes THE SAME torn states — one
// definition, two consumers (the suite asserts per-point law in depth; the
// driver sweeps all points + accumulates G1 evidence). Editing here moves
// both; the flow-partition constitution asserts the point set is exactly
// RECONCILER_KILL_POINTS.
// ---------------------------------------------------------------------------

/** What a correct reconciliation of the kill-point's torn state must conclude. */
export interface KillPointExpectation {
  /** null ⇒ the kill left nothing durable; boot is clean. */
  readonly disposition: IntentDisposition | null;
  readonly state: 'done' | 'aborted' | 'intent' | 'absent';
}

export interface KillPointFixture {
  readonly point: string;
  /** Build the durable torn state; returns the pending intentId (or null). */
  readonly setup: (w: ReconcileWorld) => Promise<string | null>;
  readonly expected: KillPointExpectation;
  /** Park intents: total scope refs for the zero-loss identity secured+left==refs. */
  readonly scopeRefs?: number;
}

// Fixture ordinals (named per §2 — testkit is not a *.test.ts file, the
// magic-number law binds here exactly as in production).
const SCOPE_TAB_A = 1;
const SCOPE_TAB_B = 2;
const SCOPE_TAB_C = 3;
const RESUME_TAB_A = 7;
const RESUME_TAB_B = 8;
/** The durable constants named in fixture rows (scope refs per park point). */
export const PARK_POINT_SCOPE_REFS = 3;

const PARK_SCOPE = {
  tabIds: [browserTabId(SCOPE_TAB_A), browserTabId(SCOPE_TAB_B), browserTabId(SCOPE_TAB_C)],
};
const CLOSE_PARTIAL = [SCOPE_TAB_A, SCOPE_TAB_B] as const;
const CLOSE_ALL = [SCOPE_TAB_A, SCOPE_TAB_B, SCOPE_TAB_C] as const;

export const KILL_POINT_FIXTURES: readonly KillPointFixture[] = [
  {
    point: 'park.commit-intent.before',
    setup: async () => null, // killed before the hinged commit — nothing durable
    expected: { disposition: null, state: 'absent' },
  },
  {
    point: 'park.commit-intent.after',
    setup: async (w) => acceptIntent(w, 1, 'ParkAll', PARK_SCOPE),
    expected: { disposition: 'aborted-conservative', state: 'aborted' },
    scopeRefs: PARK_POINT_SCOPE_REFS,
  },
  {
    point: 'park.browser-close.mid-batch',
    setup: async (w) => {
      const id = await acceptIntent(w, 1, 'ParkAll', PARK_SCOPE);
      await observeThenClose(w, CLOSE_PARTIAL); // 2 of 3 closes landed
      return id;
    },
    expected: { disposition: 'aborted-conservative', state: 'aborted' },
    scopeRefs: PARK_POINT_SCOPE_REFS,
  },
  {
    point: 'park.commit-completion.before',
    setup: async (w) => {
      const id = await acceptIntent(w, 1, 'ParkAll', PARK_SCOPE);
      await observeThenClose(w, CLOSE_ALL); // every close provable, event not yet written
      return id;
    },
    expected: { disposition: 'completed-evidence', state: 'done' },
    scopeRefs: PARK_POINT_SCOPE_REFS,
  },
  {
    point: 'park.commit-completion.after',
    setup: async (w) => {
      const id = await acceptIntent(w, 1, 'ParkAll', PARK_SCOPE);
      await observeThenClose(w, CLOSE_ALL);
      await w.append([tabsParked(w, id, PARK_POINT_SCOPE_REFS)]); // completion durable, row-flip never landed
      return id;
    },
    expected: { disposition: 'completed-safe', state: 'done' },
    scopeRefs: PARK_POINT_SCOPE_REFS,
  },
  {
    point: 'resume.intent.after',
    setup: async (w) =>
      acceptIntent(w, 1, 'ResumeMission', { missionId: missionId(1), mode: 'everything' }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'resume.window-create.mid',
    setup: async (w) => {
      const id = await acceptIntent(w, 1, 'ResumeMission', {
        missionId: missionId(1),
        mode: 'everything',
      });
      await w.append([tabObserved(w, RESUME_TAB_A)]); // a tab materialized mid-resume: no proof either way
      return id;
    },
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'resume.tab-create.mid-batch',
    setup: async (w) => {
      const id = await acceptIntent(w, 1, 'ResumeMission', {
        missionId: missionId(1),
        mode: 'everything',
      });
      await w.append([tabObserved(w, RESUME_TAB_A), tabObserved(w, RESUME_TAB_B)]);
      return id;
    },
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'delete.commit.before',
    setup: async () => null,
    expected: { disposition: null, state: 'absent' },
  },
  {
    point: 'delete.commit.after',
    setup: async (w) => acceptIntent(w, 1, 'DeleteEntity', { kind: 'mission', id: missionId(1) }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'undo.apply.mid',
    setup: async (w) => acceptIntent(w, 1, 'Undo', { actionId: 'a1' }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'import.commit.chunk-mid',
    setup: async (w) => acceptIntent(w, 1, 'ImportCommit', { importId: 'imp-1', chunk: 3 }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'import.commit.before-final-marker',
    setup: async (w) =>
      acceptIntent(w, 1, 'ImportCommit', { importId: 'imp-1', chunk: 5, final: false }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'trash.sweep.mid',
    setup: async (w) => acceptIntent(w, 1, 'EmptyTrash', { olderThanDays: 30 }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
  {
    point: 'archive.conclude.mid.artifact-write',
    setup: async (w) => acceptIntent(w, 1, 'ConcludeMission', { missionId: missionId(1) }),
    expected: { disposition: 'deferred', state: 'intent' },
  },
];

/** Type snapshot of one resolution for determinism comparisons (volatile fields out). */
export const decisionProjection = (r: {
  intentId: Id;
  disposition: string;
  reason: string;
  stale: string;
  securedCounted: number;
  liveLeftOpen: number;
  evidenceTabs: readonly number[];
}): Record<string, unknown> => ({
  intentId: r.intentId,
  disposition: r.disposition,
  reason: r.reason,
  stale: r.stale,
  securedCounted: r.securedCounted,
  liveLeftOpen: r.liveLeftOpen,
  evidenceTabs: [...r.evidenceTabs].sort((a, b) => a - b),
});
