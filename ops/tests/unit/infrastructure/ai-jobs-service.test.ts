// E8-T01 · the AI jobs service pump laws (ops lane, unit project) — the row's
// completion gate is here: the offscreen-kill exactly-once proof (S8), host
// fallthrough on workroom collapse (S7), reject+count, retry→lane-fallback,
// lane windows, single-flight, and the wired §12 probe rows.
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createIntentLedger } from '@/infrastructure/intents/ledger.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import { AI_LANE_DEADLINE_MS, createAiJobsService } from '@/application/usecases/ai-jobs.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { createIdGenerator, type Id } from '@/shared-kernel/identity/index.js';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import { computeContractHash, validateMessage } from '@/application/contracts/index.js';
import { MESSAGE_REGISTRY, type MessageSpec } from '@/application/contracts/message.registry.js';
import type { MessageEnvelope } from '@/application/contracts/envelope.js';
import type { ValidatedMessage } from '@/application/contracts/validate.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { AiJobRow } from '@/application/ports/ai-jobs.port.js';
import type { OffscreenPort } from '@/application/ports/offscreen.port.js';
import {
  createAiJobQueue,
  createAiLadder,
  createHeuristicNamer,
  createSwLocalWorkerHost,
  createWorkroomHostPair,
  JOB_LEASE_MS,
} from '@/infrastructure/ai/index.js';
import type { AiProviderPort } from '@/infrastructure/ai/ladder.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import { ok, type LedgeError } from '@/shared-kernel/result/index.js';
import { createDefaultProbes } from '@/infrastructure/diagnostics/probes.js';

const WALL = 1_786_100_000_000;
const DRAIN_ROUNDS = 12;

interface ManualScheduler {
  readonly after: (delayMs: number, fn: () => void) => () => void;
  readonly fire: (delayMs: number) => void;
  readonly pending: () => number;
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
    pending: () => timers.length,
  };
};

const ctx: UseCtx = {
  cid: 'cid-test',
  token: { cid: 'cid-test', isCancelled: () => false, throwIfCancelled: () => undefined },
  progress: { emit: () => undefined, readonly: () => undefined } as unknown as UseCtx['progress'],
  notifyPending: () => undefined,
};

/** Scripted workroom responder: receives every outbound envelope; tests decide
 *  what the "document" answers (Ready, claim, beats, results, death). */
interface FakeDoc {
  readonly outbox: readonly MessageEnvelope[];
  readonly respond: (script: FakeDocScript) => void;
  readonly answerAll: () => Promise<void>;
}

type FakeDocScript = (env: MessageEnvelope, answer: (v: ValidatedMessage) => void) => boolean;

interface Harness {
  readonly engine: StorageEnginePort;
  service: ReturnType<typeof createAiJobsService>;
  queue: ReturnType<typeof createAiJobQueue>;
  readonly scheduler: ManualScheduler;
  doc: FakeDoc;
  readonly events: () => Promise<readonly EventEnvelope[]>;
  readonly artifactEvents: () => Promise<readonly EventEnvelope[]>;
  readonly jobRow: (jobId: string) => Promise<AiJobRow | undefined>;
  readonly pump: () => Promise<unknown>;
  readonly drain: () => Promise<void>;
  nowValue: number;
  backgroundOpen: boolean;
}

let cidSeq = 0;
/** Envelope cids are ULIDs by law (§3.1) — fabricate shape-valid ones. */
const nextCid = (): Id => {
  cidSeq += 1;
  const hex = cidSeq.toString(16).toUpperCase().padStart(6, '0');
  return `01KZTEST0000000000000${hex}`.slice(0, 26) as Id;
};

const asValidated = (name: string, payload: Record<string, unknown>): ValidatedMessage => {
  const encoded: MessageEnvelope = {
    v: CONTRACT_V,
    kind: 'event',
    name,
    cid: nextCid(),
    senderContext: 'offscreen',
    payload,
    contractHash: computeContractHash(),
  };
  const outcome = validateMessage(encoded, { zone: 'zone0' });
  if (outcome.type !== 'ok') throw new Error(`invalid test envelope: ${name}`);
  return outcome.message;
};

const makeHarness = async (
  opts: {
    readonly providers?: readonly AiProviderPort[];
    readonly withWorkroom?: boolean;
  } = {},
): Promise<Harness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const ledger = createIntentLedger({ engine, journal });
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  const h: Harness = {
    engine,
    scheduler: makeScheduler(),
    doc: undefined as unknown as FakeDoc,
    queue: undefined as unknown as ReturnType<typeof createAiJobQueue>,
    service: undefined as unknown as ReturnType<typeof createAiJobsService>,
    nowValue: WALL,
    backgroundOpen: false,
    events: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error('readRange failed');
      return r.value.events.map((e) => e.envelope);
    },
    artifactEvents: async () =>
      (await h.events()).filter((e) => e.type === 'MemoryArtifactWritten'),
    jobRow: async (jobId) => {
      const r = await engine.txn(['ai_jobs'], 'readonly', async (tx) =>
        tx.table<AiJobRow & Readonly<Record<string, unknown>>>('ai_jobs').get(jobId),
      );
      if (!r.ok) throw new Error('row read failed');
      return r.value;
    },
    pump: async () => {
      const r = await h.service.pump(ctx);
      if (!r.ok) throw new Error(`pump failed: ${r.error.code}`);
      return r.value;
    },
    drain: async () => {
      for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
        h.scheduler.fire(0);
        await new Promise((r) => setTimeout(r, 0));
        // Workroom rounds interleave: the fake document's queued answers are
        // delivered every round so handshake → offer → result can complete.
        await h.doc.answerAll();
      }
    },
  };

  // Deterministic ids/now.
  let tick = 0;
  const ids = createIdGenerator({
    now: () => WALL + (tick += 1),
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  });
  const now = (): number => {
    h.nowValue += 1;
    return h.nowValue;
  };
  const appender = createStreamAppender({ journal, projections, deviceId: DEV_A, ids, now });

  // Fake document driver: capture outbound, answer via scripted rule.
  const sent: MessageEnvelope[] = [];
  let script: FakeDocScript = () => false;
  const inboxQueue: ValidatedMessage[] = [];

  let pair: ReturnType<typeof createWorkroomHostPair> | null = null;
  h.doc = {
    outbox: sent,
    respond: (rule: FakeDocScript) => {
      script = rule;
    },
    answerAll: async () => {
      while (inboxQueue.length > 0) {
        const v = inboxQueue.shift();
        if (v !== undefined) pair?.inbox(v);
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };

  const fakeOffscreen: OffscreenPort = {
    hasDocument: () => Promise.resolve(ok(true)),
    ensureDocument: () => Promise.resolve(ok({ spawned: true, ensuredAt: WALL })),
    closeDocument: () => Promise.resolve(ok({})),
    capability: () =>
      ok({
        apiPresent: true,
        reasonTable: {
          'ai-jobs': ['WORKERS'],
          'index-build': ['WORKERS'],
          'import-parse': ['WORKERS'],
          'export-render': ['WORKERS', 'BLOBS'],
        },
        reasonDrift: [],
      }),
  };

  const queue = createAiJobQueue({ engine });
  h.queue = queue;
  const ladder = createAiLadder({
    providers: opts.providers ?? [createHeuristicNamer()],
  });
  const swLocal = createSwLocalWorkerHost({ ladder });

  if (opts.withWorkroom === true) {
    pair = createWorkroomHostPair({
      offscreen: fakeOffscreen,
      send: (m) => {
        sent.push(m);
        // The fake document answers synchronously per the installed script.
        script(m, (v) => inboxQueue.push(v));
      },
      encode: ({ name, payload }) => ({
        v: CONTRACT_V,
        kind: 'event',
        name,
        cid: nextCid(),
        senderContext: 'sw',
        payload,
        contractHash: computeContractHash(),
      }),
    });
  }

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
  h.service = createAiJobsService(edge, {
    queue,
    swLocal,
    workroom: pair,
    breakers: ladder.breakerReports,
    window: {
      maintenanceOk: () => Promise.resolve(true),
      backgroundOk: () => Promise.resolve(h.backgroundOpen),
    },
    scheduler: h.scheduler,
  });

  return h;
};

const MISSION_ONE = testId(101);

const nameJob = (
  over: Partial<{
    subjectId: string;
    lane: 'interactive' | 'maintenance' | 'background';
    tabCount: number;
    domains: string[];
  }> = {},
) => ({
  subjectId: over.subjectId ?? MISSION_ONE,
  lane: over.lane ?? ('maintenance' as const),
  input: {
    tabCount: over.tabCount ?? 12,
    rootDomains: over.domains ?? ['docs.example', 'time.example'],
    takenAt: WALL,
  },
});

const artifactPayload = (env: EventEnvelope): Record<string, unknown> =>
  env.payload as Record<string, unknown>;

describe('AI jobs service — pump laws', () => {
  it('S1: sw-local happy path — one hinged commit writes event+marker in one fate', async () => {
    const h = await makeHarness();
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    expect(enq.value.coalesced).toBe(false);
    await h.drain();
    // Terminal facts: exactly one MemoryArtifactWritten, exact payload laws.
    const events = await h.artifactEvents();
    expect(events.length).toBe(1);
    const p = artifactPayload(events[0] as EventEnvelope);
    expect(p['subjectId']).toBe(MISSION_ONE);
    expect(p['kind']).toBe('mission-name');
    expect(p['provider']).toBe('heuristic');
    expect(String(p['modelClass'])).toContain('heuristic-');
    expect(p['confidence']).toBe(0.55);
    expect(p['schemaV']).toBe(1);
    expect(String(p['value'])).toContain('12 tabs');
    // Marker: the job is done and artifactRef points at the event's artifactId.
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.artifactRef).toBe(p['artifactId']);
  });

  it('S2: duplicate subject+state enqueues coalesce — still exactly one artifact', async () => {
    const h = await makeHarness();
    const a = await h.service.enqueueMissionName(nameJob(), ctx);
    const b = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!a.ok || !b.ok) throw new Error('enqueue failed');
    expect(b.value.coalesced).toBe(true);
    expect(b.value.jobId).toBe(a.value.jobId);
    await h.drain();
    expect((await h.artifactEvents()).length).toBe(1);
  });

  it('S3: malformed candidate ⇒ terminal failure + counted (never shipped)', async () => {
    const broken: AiProviderPort = {
      providerId: 'poison-shape',
      modelClass: 'ml-test-v1',
      capabilities: ['mission-name'],
      // Missing confidence/provider/modelClass — §2.12's malformed class.
      run: () =>
        Promise.resolve(ok({ value: 'x', schemaV: 1 } as unknown as MemoryArtifactCandidate)),
    };
    const h = await makeHarness({ providers: [broken] });
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    expect((await h.artifactEvents()).length).toBe(0);
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).toBe('failed');
    expect(row?.failureClass).toBe('malformed-artifact');
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.queue.malformedRejected).toBe(1);
  });

  it('S4: law-breaking values (confidence out of range) ⇒ artifact-invalid counted', async () => {
    const broken: AiProviderPort = {
      providerId: 'poison-value',
      modelClass: 'ml-test-v1',
      capabilities: ['mission-name'],
      run: () =>
        Promise.resolve(
          ok({
            value: 'some name',
            confidence: 99,
            provider: 'poison-value',
            modelClass: 'ml-test-v1',
            schemaV: 1,
          }),
        ),
    };
    const h = await makeHarness({ providers: [broken] });
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    expect((await h.artifactEvents()).length).toBe(0);
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.failureClass).toBe('artifact-invalid');
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.queue.invalidRejected).toBe(1);
  });

  it('S5: provider error ⇒ next rung in the attempt; full ladder failure ⇒ retry to forced-heuristic then exhaustion', async () => {
    // First half: failing elevated rung + heuristic fallback completes in ONE claim.
    const failing: AiProviderPort = {
      providerId: 'cloud-a',
      modelClass: 'ml-cloud-v1',
      capabilities: ['mission-name'],
      run: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'E_CAPABILITY', retryable: true } as unknown as LedgeError,
        }),
    };
    const h1 = await makeHarness({ providers: [failing, createHeuristicNamer()] });
    const enq1 = await h1.service.enqueueMissionName(nameJob({ subjectId: testId(102) }), ctx);
    if (!enq1.ok) throw new Error('enqueue failed');
    await h1.drain();
    expect((await h1.artifactEvents()).length).toBe(1);
    const s1 = await h1.service.stats();
    if (!s1.ok) throw new Error('stats failed');
    expect(s1.value.breakers.find((b) => b.providerId === 'cloud-a')?.consecutiveFailures).toBe(1);
    // Second half: BOTH rungs fail ⇒ released+retried through the budget, then exhausted.
    const failing2: AiProviderPort = {
      providerId: 'heuristic',
      modelClass: 'heuristic-broken-v1',
      capabilities: ['mission-name'],
      run: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'E_CAPABILITY', retryable: true } as unknown as LedgeError,
        }),
    };
    const h2 = await makeHarness({ providers: [failing2] });
    const enq2 = await h2.service.enqueueMissionName(nameJob({ subjectId: testId(103) }), ctx);
    if (!enq2.ok) throw new Error('enqueue failed');
    for (let pump = 0; pump < 6; pump += 1) {
      await h2.pump();
    }
    const row = await h2.jobRow(enq2.value.jobId);
    expect(row?.state).toBe('failed');
    expect(row?.failureClass).toBe('attempts-exhausted');
    expect((await h2.artifactEvents()).length).toBe(0);
  });

  it('S6: workroom lane — §3.6 round trip completes via the workroom host', async () => {
    const h = await makeHarness({ withWorkroom: true });
    // Fake document: Ready on ensure, then claim+beat+result on offer.
    h.doc.respond((env, answer) => {
      if (env.name === 'EnsureWorkroom')
        answer(asValidated('WorkroomReady', { capabilitiesResolved: {} }));
      if (env.name === 'JobOffer') {
        const jobId = String((env.payload as Record<string, unknown>)['jobId']);
        answer(asValidated('JobClaimed', { jobId, workerTag: 'offscreen' }));
        answer(asValidated('JobHeartbeat', { jobId, pct: 0 }));
        answer(
          asValidated('JobResult', {
            jobId,
            ok: true,
            artifact: {
              value: '12 tabs · docs & time · 4:32 pm',
              confidence: 0.55,
              provider: 'heuristic',
              modelClass: 'heuristic-domain-time-v1',
              schemaV: 1,
            },
          }),
        );
      }
      return true;
    });
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    await h.doc.answerAll();
    await h.drain();
    const events = await h.artifactEvents();
    expect(events.length).toBe(1);
    const names = h.doc.outbox.map((m) => m.name);
    expect(names).toContain('EnsureWorkroom');
    expect(names).toContain('JobOffer');
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.workroom.ready).toBe(true);
    expect(stats.value.workroom.consecutiveLosses).toBe(0);
  });

  it('S7: workroom collapse mid-offer ⇒ same-claim fallthrough to heuristic tier (exactly-once holds)', async () => {
    const h = await makeHarness({ withWorkroom: true });
    h.doc.respond((env, answer) => {
      if (env.name === 'EnsureWorkroom')
        answer(asValidated('WorkroomReady', { capabilitiesResolved: {} }));
      if (env.name === 'JobOffer') {
        // The document DIES instead of answering (Blueprint §9 row 6).
        answer(asValidated('WorkroomShutdown', { reason: 'idle' }));
      }
      return true;
    });
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    await h.doc.answerAll();
    await h.drain();
    // Fallthrough completed on the SW-local heuristic host — one artifact total.
    const events = await h.artifactEvents();
    expect(events.length).toBe(1);
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.attempts).toBe(1);
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.workroom.consecutiveLosses).toBe(1);
    expect(stats.value.workroom.backoffUntil).not.toBeNull();
  });

  it('S8: OFFSCREEN-KILL EXACTLY-ONCE — silent death, deadline abandon, lease reclaim, retry completes, single artifact', async () => {
    const h = await makeHarness({ withWorkroom: true });
    // The document answers Ready once, then dies SILENTLY (no shutdown envelope,
    // no job traffic — the pure kill case: the lease layer owns recovery).
    h.doc.respond((env, answer) => {
      if (env.name === 'EnsureWorkroom')
        answer(asValidated('WorkroomReady', { capabilitiesResolved: {} }));
      return true; // JobOffer: dead silence
    });
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    const jobId = enq.value.jobId;
    // Handshake completes (Ready delivered), the offer is out, the document is
    // now SILENT — the claim hangs at the workroom host awaiting a result.
    await h.drain();
    expect(h.doc.outbox.map((m) => m.name)).toContain('JobOffer');
    // Fire the lane deadline (maintenance = 30s): abandon (JobCancel
    // best-effort) + release with the attempt consumed.
    h.scheduler.fire(AI_LANE_DEADLINE_MS.maintenance);
    await new Promise((r) => setTimeout(r, 0));
    const canceled = h.doc.outbox.filter((m) => m.name === 'JobCancel');
    expect(canceled.length).toBe(1);
    expect((await h.jobRow(jobId))?.state).toBe('queued');
    // Lease expires ⇒ reclaim ⇒ retry. Backoff routes to the SW-local host.
    h.nowValue += JOB_LEASE_MS + 1_000;
    await h.pump();
    await h.drain();
    const events = await h.artifactEvents();
    expect(events.length).toBe(1);
    const row = await h.jobRow(jobId);
    expect(row?.state).toBe('done');
    expect(row?.attempts).toBe(2);
    expect(row?.artifactRef).toBe(artifactPayload(events[0] as EventEnvelope)['artifactId']);
  });

  it('S9: concurrent pumps are single-flight (coalesce to one drain)', async () => {
    const h = await makeHarness();
    await h.service.enqueueMissionName(nameJob({ subjectId: testId(104) }), ctx);
    await h.service.enqueueMissionName(nameJob({ subjectId: testId(105) }), ctx);
    const both = await Promise.all([h.service.pump(ctx), h.service.pump(ctx)]);
    if (!both[0].ok || !both[1].ok) throw new Error('pump failed');
    await h.drain();
    await h.pump();
    expect((await h.artifactEvents()).length).toBe(2);
  });

  it('S10: lane windows — background held until the window opens (§10 doctrine)', async () => {
    const h = await makeHarness();
    const enq = await h.service.enqueueMissionName(nameJob({ lane: 'background' }), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    const idle = await h.service.pump(ctx);
    if (!idle.ok) throw new Error('pump failed');
    expect(idle.value.kind).toBe('idle');
    expect((await h.jobRow(enq.value.jobId))?.state).toBe('queued');
    h.backgroundOpen = true;
    await h.pump();
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect((await h.artifactEvents()).length).toBe(1);
  });

  it('S11: the inbox ignores non-family names (dispatcher keeps totality)', async () => {
    const h = await makeHarness({ withWorkroom: true });
    // SegmentsPull is event-kind but SYNC family and v2-boundary — today's wire
    // cannot produce it validated (validateMessage ignores unavailable names),
    // so fabricate the validated shape the inbox WILL see once v2 sync ships.
    // The totality law under test: the workroom inbox refuses ANY name outside
    // its family, however plausible the envelope.
    const alien = {
      v: CONTRACT_V,
      kind: 'event',
      family: 'sync',
      availability: 'v2-boundary',
      name: 'SegmentsPull',
      cid: nextCid(),
      senderContext: 'sw',
      payload: { deviceId: 'device-b', sinceSeq: 0 },
      spec: MESSAGE_REGISTRY['SegmentsPull'] as MessageSpec,
    } satisfies ValidatedMessage;
    expect(h.service.inbox(alien)).toBe(false);
    expect(h.service.inbox(asValidated('WorkroomReady', { capabilitiesResolved: {} }))).toBe(true);
  });
});

describe('AI jobs service — wired §12 probe rows', () => {
  const buildSeamedProbes = async (h: Harness) => {
    const journal = createJournal(h.engine);
    const projections = createV1ProjectionEngine({
      engine: h.engine,
      journal,
      onDelta: () => undefined,
    });
    const ledger = createIntentLedger({ engine: h.engine, journal });
    return createDefaultProbes({
      engine: h.engine,
      journal: {
        scanTail: () =>
          Promise.resolve(
            ok({
              status: 'ok' as const,
              coverage: 'tail' as const,
              suspects: [],
              devices: [DEV_A],
            }),
          ),
        scanFull: () =>
          Promise.resolve(
            ok({
              status: 'ok' as const,
              coverage: 'full' as const,
              suspects: [],
              devices: [DEV_A],
            }),
          ),
      } as never,
      projections,
      ledger,
      search: {
        query: () => Promise.resolve({ ok: false, error: { code: 'E_CAPABILITY' } }) as never,
        dupesFor: () => Promise.resolve(ok([])),
        freshness: () => Promise.resolve(ok({ lag: 0, dirty: false, tokenizerV: 1 })),
        ensureIndexFresh: () => Promise.resolve(ok({})),
      } as never,
      now: () => WALL,
      aiLanes: { stats: () => h.service.stats() },
      offscreen: {
        capability: () =>
          ok({
            apiPresent: true,
            reasonTable: {
              'ai-jobs': ['WORKERS'],
              'index-build': ['WORKERS'],
              'import-parse': ['WORKERS'],
              'export-render': ['WORKERS', 'BLOBS'],
            },
            reasonDrift: [],
          }),
        stats: () => h.service.stats(),
      },
    });
  };

  it('P1: ai-lanes wired row reports depths + breakers + rejected counts (ok posture)', async () => {
    const h = await makeHarness();
    const enq = await h.service.enqueueMissionName(nameJob(), ctx);
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    const probes = await buildSeamedProbes(h);
    const probe = probes['ai-lanes'];
    if (probe === undefined) throw new Error('ai-lanes probe missing');
    const row = await probe();
    expect(row.wired).toBe(true);
    expect(row.status).toBe('ok');
    expect(String(row.fields['depths'])).toContain('maintenance:0q/0c');
    expect(Number(row.fields['failed'])).toBe(0);
  });

  it('P2: offscreen-spawn wired row reports capability + drift + workroom posture', async () => {
    const h = await makeHarness();
    const probes = await buildSeamedProbes(h);
    const probe = probes['offscreen-spawn'];
    if (probe === undefined) throw new Error('offscreen-spawn probe missing');
    const row = await probe();
    expect(row.wired).toBe(true);
    expect(row.status).toBe('ok');
    expect(row.fields['apiPresent']).toBe(true);
    expect(String(row.fields['reasonDrift'])).toBe('none');
  });
});
