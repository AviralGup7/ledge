// E8-T01 · chaos lane — the AI job queue kill-point matrix (EES §2.12 + Blueprint
// §9 row 6). Each scenario tears the pipeline at one enumerated point and drives
// the RESURRECTION through a fresh service graph over the same durable engine
// (the SW-restart model: code dies, IndexedDB truth does not). The outcome law
// under every kill is identical: EXACTLY ONE MemoryArtifactWritten event, the
// terminal marker etched, and the attempt ledger honest.
//
//   C1 kill after enqueue, before claim      → resurrection claims + completes
//   C2 kill after claim, before execute      → 2 missed beats ⇒ reclaim ⇒ retry
//   C3 zombie-SW duplicate-completion race   → one artifact; the loser's hinged
//                                              commit aborts (one fate)
//   C4 injected torn commit (typed fault)    → release + retry; nothing partial
//   C5 seeded IDB latency over the whole arc → outcome-invariant (EES §8)
//
// Determinism: manual schedulers per service, one shared wall clock per scenario,
// distinct id streams per spawned graph (idsSeed). No real timers, no sleeps.
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createIntentLedger } from '@/infrastructure/intents/ledger.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import { createAiJobsService, type AiJobsService } from '@/application/usecases/ai-jobs.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import type {
  StorageEnginePort,
  StoreName,
  TxnMode,
  TxScope,
} from '@/application/ports/storage-engine.port.js';
import type { AiJobQueuePort, AiJobRow } from '@/application/ports/ai-jobs.port.js';
import {
  createAiJobQueue,
  createAiLadder,
  createHeuristicNamer,
  createSwLocalWorkerHost,
  JOB_LEASE_MS,
} from '@/infrastructure/ai/index.js';
import type { AiProviderPort } from '@/infrastructure/ai/ladder.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { withFaults } from '../../chaos/faults.js';

const WALL = 1_786_200_000_000;
const IDS_STRIDE = 100_000;

const ctx: UseCtx = {
  cid: 'cid-chaos',
  token: { cid: 'cid-chaos', isCancelled: () => false, throwIfCancelled: () => undefined },
  progress: { emit: () => undefined, readonly: () => undefined } as unknown as UseCtx['progress'],
  notifyPending: () => undefined,
};

interface ManualScheduler {
  readonly after: (delayMs: number, fn: () => void) => () => void;
  readonly fire: (delayMs: number) => void;
}

const makeScheduler = (): ManualScheduler => {
  let timers: { id: number; delayMs: number; fn: () => void }[] = [];
  let next = 0;
  return {
    after: (delayMs, fn) => {
      const id = (next += 1);
      timers.push({ id, delayMs, fn });
      return () => {
        timers = timers.filter((t) => t.id !== id);
      };
    },
    fire: (delayMs) => {
      const due = timers.filter((t) => t.delayMs <= delayMs);
      timers = timers.filter((t) => t.delayMs > delayMs);
      for (const timer of due) timer.fn();
    },
  };
};

/** One resurrectable service graph over a scenario's durable engine. The graph is
 *  cheap to build and kills cost nothing — THAT is the restart model. */
interface Spawned {
  readonly service: AiJobsService;
  readonly queue: AiJobQueuePort;
  readonly scheduler: ManualScheduler;
}

interface Scenario {
  readonly engine: StorageEnginePort;
  readonly nowCell: { now: number };
  readonly events: () => Promise<readonly EventEnvelope[]>;
  readonly artifactEvents: () => Promise<readonly EventEnvelope[]>;
  readonly row: (jobId: string) => Promise<AiJobRow | undefined>;
  readonly spawn: (opts: { idsSeed: number; providers?: readonly AiProviderPort[] }) => Spawned;
}

const makeScenario = async (
  engineWrap?: (e: StorageEnginePort) => StorageEnginePort,
): Promise<Scenario> => {
  const realEngine = await openEngine();
  const engine = engineWrap === undefined ? realEngine : engineWrap(realEngine);
  const nowCell = { now: WALL };
  const readJournal = createJournal(engine);
  const scenario: Scenario = {
    engine,
    nowCell,
    events: async () => {
      const r = await readJournal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error('readRange failed');
      return r.value.events.map((e) => e.envelope);
    },
    artifactEvents: async () =>
      (await scenario.events()).filter((e) => e.type === 'MemoryArtifactWritten'),
    row: async (jobId) => {
      const r = await engine.txn(['ai_jobs'], 'readonly', async (tx) =>
        tx.table<AiJobRow & Readonly<Record<string, unknown>>>('ai_jobs').get(jobId),
      );
      if (!r.ok) throw new Error('row read failed');
      return r.value;
    },
    spawn: ({ idsSeed, providers }) => {
      const journal = createJournal(engine);
      const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
      const ledger = createIntentLedger({ engine, journal });
      let tick = 0;
      const idsBase = WALL + idsSeed * IDS_STRIDE;
      const ids = createIdGenerator({
        now: () => idsBase + (tick += 1),
        randomBytes: (n: number) => new Uint8Array(n).fill(7),
      });
      const now = (): number => {
        nowCell.now += 1;
        return nowCell.now;
      };
      const appender = createStreamAppender({ journal, projections, deviceId: DEV_A, ids, now });
      const queue = createAiJobQueue({ engine });
      const ladder = createAiLadder({ providers: providers ?? [createHeuristicNamer()] });
      const swLocal = createSwLocalWorkerHost({ ladder });
      const scheduler = makeScheduler();
      const deps = {
        engine,
        journal,
        projections,
        ledger,
        ids,
        deviceId: DEV_A,
        now,
      } as unknown as ServiceDeps;
      const edge: ServiceEdge = { deps, appender };
      const service = createAiJobsService(edge, {
        queue,
        swLocal,
        workroom: null,
        breakers: ladder.breakerReports,
        window: {
          maintenanceOk: () => Promise.resolve(true),
          backgroundOk: () => Promise.resolve(true),
        },
        scheduler,
      });
      return { service, queue, scheduler };
    },
  };
  return scenario;
};

const nameJob = (
  subjectN: number,
): {
  subjectId: string;
  lane: 'maintenance';
  input: { tabCount: number; rootDomains: string[]; takenAt: number };
} => ({
  subjectId: testId(subjectN),
  lane: 'maintenance',
  input: { tabCount: 9, rootDomains: ['docs.example', 'time.example'], takenAt: WALL },
});

const flushMicro = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('E8-T01 · AI queue kill-point matrix (§2.12 exactly-once under resurrection)', () => {
  it('C1: kill after enqueue, before claim — resurrection claims and completes', async () => {
    const sc = await makeScenario();
    const dead = sc.spawn({ idsSeed: 1 });
    const enq = await dead.service.enqueueMissionName(nameJob(201), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    // THE KILL: the graph dies with the job durable-but-unclaimed. No drain, no pump.
    expect((await sc.row(enq.value.jobId))?.state).toBe('queued');
    // Resurrection: a fresh graph over the same engine owns the world now.
    const risen = sc.spawn({ idsSeed: 2 });
    const disposition = await risen.service.pump(ctx);
    if (!disposition.ok) throw new Error('pump failed');
    expect(disposition.value.kind).toBe('completed');
    const events = await sc.artifactEvents();
    expect(events.length).toBe(1);
    const row = await sc.row(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.attempts).toBe(1);
    expect(row?.artifactRef).toBe((events[0]?.payload as Record<string, unknown>)['artifactId']);
  });

  it('C2: kill after claim, before execute — 2 missed beats ⇒ reclaim ⇒ retry completes', async () => {
    const sc = await makeScenario();
    const dead = sc.spawn({ idsSeed: 1 });
    const enq = await dead.service.enqueueMissionName(nameJob(202), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    // The doomed worker claims directly, then dies WITHOUT executing (the torn
    // lease is the durable evidence of the crash window).
    const claimed = await dead.queue.claimNext({
      lanes: ['maintenance'],
      workerTag: 'doomed-worker',
      now: sc.nowCell.now,
    });
    if (!claimed.ok) throw new Error('claim failed');
    expect(claimed.value?.jobId).toBe(enq.value.jobId);
    expect((await sc.row(enq.value.jobId))?.state).toBe('claimed');
    // THE KILL. Two missed beats pass (lease = 3 beats by law).
    sc.nowCell.now += JOB_LEASE_MS + 1_000;
    const risen = sc.spawn({ idsSeed: 2 });
    const reclaimed = await risen.queue.reclaimExpired({ now: sc.nowCell.now });
    if (!reclaimed.ok) throw new Error('reclaim failed');
    expect(reclaimed.value.reclaimed).toEqual([enq.value.jobId]);
    // Idempotent sweep law: a second sweep over the same expiry is a no-op.
    const again = await risen.queue.reclaimExpired({ now: sc.nowCell.now });
    if (!again.ok) throw new Error('reclaim failed');
    expect(again.value.reclaimed).toEqual([]);
    const disposition = await risen.service.pump(ctx);
    if (!disposition.ok) throw new Error('pump failed');
    expect(disposition.value.kind).toBe('completed');
    const events = await sc.artifactEvents();
    expect(events.length).toBe(1);
    const row = await sc.row(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.attempts).toBe(2); // the dead claim stands as consumed evidence
  });

  it('C3: zombie-SW duplicate completion — exactly ONE artifact survives the race', async () => {
    const sc = await makeScenario();
    // The zombie's provider blocks until the test releases it — the wedge window
    // in which the world believes the worker is dead.
    // Cell (not bare let) so control-flow never narrows the release away.
    const zombieGate: {
      release: ((r: Result<MemoryArtifactCandidate, LedgeError>) => void) | null;
    } = { release: null };
    const zombieProvider: AiProviderPort = {
      providerId: 'zombie-ml',
      modelClass: 'ml-zombie-v1',
      capabilities: ['mission-name'],
      run: () =>
        new Promise((resolve) => {
          zombieGate.release = resolve;
        }),
    };
    const zombie = sc.spawn({ idsSeed: 1, providers: [zombieProvider] });
    const enq = await zombie.service.enqueueMissionName(nameJob(203), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    const jobId = enq.value.jobId;
    // The zombie claims and wedges mid-execute (its pump hangs inside the rung).
    const zombiePump = zombie.service.pump(ctx);
    await flushMicro();
    await flushMicro();
    const wedged = await sc.row(jobId);
    expect(wedged?.state).toBe('claimed');
    // The world moves on: lease expires, the RESURRECTION graph reclaims,
    // re-claims, executes, and etches the terminal marker via its hinged commit.
    sc.nowCell.now += JOB_LEASE_MS + 1_000;
    const risen = sc.spawn({ idsSeed: 2 });
    const risenDisposition = await risen.service.pump(ctx);
    if (!risenDisposition.ok) throw new Error('risen pump failed');
    expect(risenDisposition.value.kind).toBe('completed');
    expect((await sc.row(jobId))?.state).toBe('done');
    // NOW the zombie wakes and completes — its hinged commit meets the marker
    // (journal idempotency: same key, alien payload ⇒ hard refusal; §5 law 2
    // keeps event and marker in one fate — NOTHING of the duplicate lands).
    if (zombieGate.release === null) throw new Error('zombie never ran');
    zombieGate.release(
      ok({
        value: '9 tabs · docs & time · 4:32 pm',
        confidence: 0.9,
        provider: 'zombie-ml',
        modelClass: 'ml-zombie-v1',
        schemaV: 1,
      }),
    );
    const zombieDisposition = await zombiePump;
    if (!zombieDisposition.ok) throw new Error('zombie pump failed');
    expect(zombieDisposition.value.kind).toBe('released');
    // THE LAW: exactly one artifact event in the journal. The marker names it.
    const events = await sc.artifactEvents();
    expect(events.length).toBe(1);
    const row = await sc.row(jobId);
    expect(row?.state).toBe('done');
    expect(row?.attempts).toBe(2);
    expect(row?.artifactRef).toBe((events[0]?.payload as Record<string, unknown>)['artifactId']);
  });

  it('C4: injected torn commit — typed abort, zero partial state, retry lands once', async () => {
    // Armed scope-fault wrapper: fails ONLY the hinged-commit txn (events+ai_jobs
    // in one readwrite scope). Typed + annotated + reversible (EES §8 fault law).
    let armed = false;
    let failures = 0;
    const torn = (inner: StorageEnginePort): StorageEnginePort => ({
      ...inner,
      txn: <T>(scope: readonly StoreName[], mode: TxnMode, work: (tx: TxScope) => Promise<T>) => {
        if (
          armed &&
          mode === 'readwrite' &&
          scope.includes('events') &&
          scope.includes('ai_jobs')
        ) {
          failures += 1;
          return Promise.resolve(
            err(
              ledgeError('E_CORRUPT_STORE', {
                what: 'chaos-commit-torn',
                chaosOp: 'txn:events+ai_jobs',
                chaosOrdinal: failures,
              }),
            ),
          );
        }
        return inner.txn(scope, mode, work);
      },
    });
    const sc = await makeScenario(torn);
    const g = sc.spawn({ idsSeed: 1 });
    const enq = await g.service.enqueueMissionName(nameJob(204), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    // Arm the tear at THE COMMIT (artifact validated, journal write severed).
    armed = true;
    const tornDisposition = await g.service.pump(ctx);
    if (!tornDisposition.ok) throw new Error('pump failed');
    expect(tornDisposition.value.kind).toBe('released');
    expect(failures).toBe(1);
    // Zero partial state: NO artifact event, job released (attempt consumed).
    expect((await sc.artifactEvents()).length).toBe(0);
    expect((await sc.row(enq.value.jobId))?.state).toBe('queued');
    // Heal + retry: the same idempotency key re-arms (nothing recorded pre-tear),
    // the retry's hinged commit lands the one artifact in one fate.
    armed = false;
    const healed = await g.service.pump(ctx);
    if (!healed.ok) throw new Error('pump failed');
    expect(healed.value.kind).toBe('completed');
    const events = await sc.artifactEvents();
    expect(events.length).toBe(1);
    const row = await sc.row(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.attempts).toBe(2);
  });

  it('C5: seeded IDB latency over the whole arc — outcome-invariant (EES §8)', async () => {
    const SEED = 7;
    const wrapped = await openEngine();
    const faulty = withFaults(wrapped, { latency: { seed: SEED, maxMs: 2 } });
    const sc = await makeScenario(() => faulty.engine);
    const g = sc.spawn({ idsSeed: 1 });
    const enq = await g.service.enqueueMissionName(nameJob(205), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    const disposition = await g.service.pump(ctx);
    if (!disposition.ok) throw new Error('pump failed');
    expect(disposition.value.kind).toBe('completed');
    const events = await sc.artifactEvents();
    expect(events.length).toBe(1);
    expect(String((events[0]?.payload as Record<string, unknown>)['value'])).toContain('9 tabs');
    expect((await sc.row(enq.value.jobId))?.state).toBe('done');
    // Latency really was applied (the evidence is annotated, never assumed).
    expect(faulty.observed.ops.length).toBeGreaterThan(0);
  });
});
