// E8-T05 · resumption briefs law (Spec §6.9 · W5) — the row's completion gate:
// the ABSENCE-PREFERENCE law end to end (A-series: pure-yield or rung-less
// attempts end done-and-silent, never failed, never counted), provider honesty
// (B-series: 2–3 sentences, verbatim hints, budgets, privacy, typed yields),
// the domain gate (D-series: show/absent/dismissed, LOW ⇒ absent — R18),
// dismiss memory (E-series: BriefDismissed covenant + idempotence), and the
// v1.1-dormant wire reserve (C-series: unavailable-name today, frozen shape).
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createIntentLedger } from '@/infrastructure/intents/ledger.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import { createAiJobsService } from '@/application/usecases/ai-jobs.js';
import { createPrefsService } from '@/application/usecases/prefs.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { EVENT_REGISTRY } from '@/shared-kernel/events/events.registry.js';
import { validatePayload } from '@/shared-kernel/events/validate.js';
import { createIdGenerator, type Id } from '@/shared-kernel/identity/index.js';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import { computeContractHash, validateMessage } from '@/application/contracts/index.js';
import { MESSAGE_REGISTRY } from '@/application/contracts/message.registry.js';
import type { MessageEnvelope } from '@/application/contracts/envelope.js';
import type { ValidatedMessage } from '@/application/contracts/validate.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { AiJobRow, MissionBriefInput } from '@/application/ports/ai-jobs.port.js';
import type { OffscreenPort } from '@/application/ports/offscreen.port.js';
import { briefsGate } from '@/domain/memory/index.js';
import { validateArtifactCandidate } from '@/domain/memory/index.js';
import {
  createAiJobQueue,
  createAiLadder,
  createHeuristicNamer,
  createSwLocalWorkerHost,
  createWorkroomHostPair,
} from '@/infrastructure/ai/index.js';
import type { AiProviderPort } from '@/infrastructure/ai/ladder.js';
import {
  createDeferredOnDeviceNamer,
  createOnDeviceNamer,
  ONDEVICE_PROVIDER_ID,
} from '@/infrastructure/ai/providers/ondevice/index.js';
import { ok } from '@/shared-kernel/result/index.js';

const WALL = 1_786_400_000_000;
const DRAIN_ROUNDS = 12;
const AMBIENT = { hasWebAssembly: true } as const;

const RICH_TITLES = [
  'Merged pull request on github',
  'GitHub notifications center',
  'react hooks in depth guide',
  'React 19 features overview',
] as const;

const briefInput = (
  titles: readonly string[],
  over: Partial<{
    domains: readonly string[];
    hint: string;
    lastActive: string;
    pending: string;
  }> = {},
): MissionBriefInput => ({
  tabCount: titles.length,
  rootDomains: over.domains ?? ['github.example', 'reactjs.example'],
  takenAt: WALL,
  tabs: titles.map((title) => ({ title, rootDomain: '' })),
  ...(over.hint !== undefined ? { missionNameHint: over.hint } : {}),
  ...(over.lastActive !== undefined ? { lastActiveTitle: over.lastActive } : {}),
  ...(over.pending !== undefined ? { pendingNote: over.pending } : {}),
});

const briefJob = (input: MissionBriefInput) => ({
  kind: 'mission-brief' as const,
  subjectId: 'mission-b',
  value: input,
});

const jobRow = (kind: 'mission-brief' | 'mission-name', input: unknown): AiJobRow => ({
  jobId: 'job-brief',
  kind,
  subjectKey: 'k',
  payloadRef: { subjectId: 'mission-b', input, stateHash: 'h' },
  lane: 'maintenance',
  state: 'claimed',
  attempts: 1,
  lease: { workerTag: 'w', expiresAt: WALL + 15_000 },
  createdAt: WALL,
  updatedAt: WALL,
  enqueuedAtSeq: 3,
});

describe('E8-T05 · provider honesty (B-series: §6.9 shape, verbatim, budgets)', () => {
  it('B1: rich evidence + both hints ⇒ three traceable sentences, calibrated, replay-stable', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const input = briefInput(RICH_TITLES, {
      lastActive: 'Merged pull request on github',
      pending: 'sweep the review queue',
    });
    const ran = await provider.run(briefJob(input));
    if (!ran.ok) throw new Error(`run failed: ${ran.error.code}`);
    const text = ran.value.value as string;
    expect(text).toContain('You left GitHub & React with 4 tabs across 2 domains.');
    expect(text).toContain('You stopped at Merged pull request on github.');
    expect(text).toContain('Pending: sweep the review queue.');
    expect(text.length).toBeLessThanOrEqual(420);
    expect(ran.value.confidence).toBe(0.88); // dual sharp stamp (naming machine law)
    expect(ran.value.provider).toBe(ONDEVICE_PROVIDER_ID);
    expect(validateArtifactCandidate(ran.value).kind).toBe('valid');
    const again = await provider.run(briefJob(input));
    if (!again.ok) throw new Error('replay failed');
    expect(again.value).toEqual(ran.value);
  });

  it('B2: state + stopped is a lawful two-sentence brief (spec floor), pending absent', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ran = await provider.run(
      briefJob(briefInput(RICH_TITLES, { lastActive: 'react hooks in depth guide' })),
    );
    if (!ran.ok) throw new Error('run failed');
    const text = ran.value.value as string;
    expect(text).toContain('You stopped at react hooks in depth guide.');
    expect(text).not.toContain('Pending:');
  });

  it('B3: rich evidence but NO hints ⇒ typed yield — state alone is a summary, not a brief', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ran = await provider.run(briefJob(briefInput(RICH_TITLES)));
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.code).toBe('E_CAPABILITY');
      expect(ran.error.details?.['yield']).toBe(true);
    }
  });

  it('B4: thin evidence yields even WITH hints — a hint never rescues the calibration floor', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ran = await provider.run(
      briefJob(
        briefInput(['सपना देखना एक अच्छी बात है', 'random daily scroll'], {
          lastActive: 'some page',
          pending: 'finish it',
        }),
      ),
    );
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.code).toBe('E_CAPABILITY');
      expect(ran.error.details?.['yield']).toBe(true);
    }
  });

  it('B5: hint caps + whitespace sanitation hold; the 420-char card budget holds', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const messy = await provider.run(
      briefJob(
        briefInput(RICH_TITLES, { lastActive: 'Deep dive\ninto\twebgpu   compute shaders' }),
      ),
    );
    if (!messy.ok) throw new Error('run failed');
    expect(messy.value.value as string).toContain(
      'You stopped at Deep dive into webgpu compute shaders.',
    );
    const longTitle = `word${'o'.repeat(10)} `.repeat(120).trim();
    const ran = await provider.run(
      briefJob(briefInput(RICH_TITLES, { lastActive: longTitle, pending: 'x'.repeat(500) })),
    );
    if (!ran.ok) throw new Error('run failed');
    const text = ran.value.value as string;
    expect(text.length).toBeLessThanOrEqual(420);
    // Verbatim caps: the envelope holds the 200-char producer budgets (the
    // capture is bounded by the pending sentence so the regex stays honest).
    const stopped = /You stopped at (.+?)\. Pending:/.exec(text);
    expect(stopped?.[1]?.length ?? 0).toBeLessThanOrEqual(200);
    const pending = /Pending: (x+)\./.exec(text);
    expect(pending?.[1]?.length ?? 0).toBeLessThanOrEqual(200);
    expect(text).not.toContain('\n');
    expect(text).not.toContain('Pending: Pending'); // raw-hint truncation, never double-wrap
  });

  it('B6: parked-tab privacy — the brief speaks counts and hints, never domain or tab strings', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const input: MissionBriefInput = {
      tabCount: 5,
      rootDomains: ['github.example', 'reactjs.example', 'secret.example'],
      takenAt: WALL,
      tabs: [
        ...RICH_TITLES.map((title) => ({ title, rootDomain: 'github.example' })),
        { title: 'secret internal dashboard', rootDomain: 'secret.example', discarded: true },
      ],
      lastActiveTitle: 'Merged pull request on github',
    };
    const ran = await provider.run(briefJob(input));
    if (!ran.ok) throw new Error('run failed');
    const text = ran.value.value as string;
    expect(text).not.toContain('secret');
    expect(text).not.toContain('.example'); // domain names never print, only counts
    expect(text).toContain('across 3 domains');
  });
});

describe('E8-T05 · ABSENCE-PREFERENCE law (A-series — the row completion criterion)', () => {
  it('A1 · CRITERION: thin evidence ⇒ pure-yield attempt ends SILENT (host), breaker untouched', async () => {
    const deferred = createDeferredOnDeviceNamer(AMBIENT);
    const ladder = createAiLadder({ providers: [deferred, createHeuristicNamer()] });
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow('mission-brief', {
        tabCount: 2,
        rootDomains: ['misc.example'],
        takenAt: WALL,
        tabs: [
          { title: 'किताबें और कहानियाँ', rootDomain: 'books.example' },
          { title: 'some vague reading pile', rootDomain: 'misc.example' },
        ],
        lastActiveTitle: 'some page',
      }),
    });
    expect(outcome.kind).toBe('silent');
    const cell = ladder.breakerReports().find((b) => b.providerId === ONDEVICE_PROVIDER_ID);
    expect(cell?.consecutiveFailures).toBe(0);
    expect(cell?.state).toBe('closed');
  });

  it('A2: rung-less law — briefs have NO heuristic rung (silent), names keep no-rung vocabulary', async () => {
    const heuristicOnly = createAiLadder({ providers: [createHeuristicNamer()] });
    const briefRungs = heuristicOnly.resolve({
      kind: 'mission-brief',
      now: WALL,
      forceHeuristic: false,
    });
    expect(briefRungs.length).toBe(0); // absence by design — no counts-form brief
    const host = createSwLocalWorkerHost({ ladder: heuristicOnly });
    const silent = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow('mission-brief', briefInput(RICH_TITLES, { lastActive: 'a page' })),
    });
    expect(silent.kind).toBe('silent'); // never 'no-rung' for absence-preferred kinds
    const named = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow('mission-name', {
        tabCount: 2,
        rootDomains: ['docs.example'],
        takenAt: WALL,
      }),
    });
    expect(named.kind).toBe('artifact'); // names still get their heuristic answer
    const emptyLadder = createAiLadder({ providers: [] });
    const noRungHost = createSwLocalWorkerHost({ ladder: emptyLadder });
    const noRung = await noRungHost.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow('mission-name', { tabCount: 1, rootDomains: [], takenAt: WALL }),
    });
    expect(noRung.kind).toBe('no-rung'); // non-preferred kinds keep the old word
  });

  it('A3: regression — summary fail-down is unchanged by the silence vocabulary', async () => {
    const deferred = createDeferredOnDeviceNamer(AMBIENT);
    const ladder = createAiLadder({ providers: [deferred, createHeuristicNamer()] });
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: {
        ...jobRow('mission-name', {}),
        kind: 'mission-summary',
        subjectKey: 'k2',
        payloadRef: {
          subjectId: 'mission-s',
          input: {
            tabCount: 2,
            rootDomains: ['misc.example'],
            takenAt: WALL,
            tabs: [
              { title: 'किताबें और कहानियाँ', rootDomain: 'books.example' },
              { title: 'some vague reading pile', rootDomain: 'misc.example' },
            ],
          },
          stateHash: 'h',
        },
      },
    });
    expect(outcome.kind).toBe('artifact');
    if (outcome.kind === 'artifact') expect(outcome.providerId).toBe('heuristic');
  });
});

// ── pump-level harness (mirrors the ai-jobs-service harness, trimmed) ────────

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

const ctx: UseCtx = {
  cid: 'cid-briefs',
  token: { cid: 'cid-briefs', isCancelled: () => false, throwIfCancelled: () => undefined },
  progress: { emit: () => undefined, readonly: () => undefined } as unknown as UseCtx['progress'],
  notifyPending: () => undefined,
};

let cidSeq = 0;
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

interface Harness {
  service: ReturnType<typeof createAiJobsService>;
  readonly scheduler: ManualScheduler;
  readonly doc: {
    readonly outbox: readonly MessageEnvelope[];
    readonly respond: (
      rule: (env: MessageEnvelope, answer: (v: ValidatedMessage) => void) => boolean,
    ) => void;
    readonly answerAll: () => Promise<void>;
  };
  readonly events: () => Promise<readonly EventEnvelope[]>;
  readonly artifactEvents: () => Promise<readonly EventEnvelope[]>;
  readonly briefDismissedEvents: () => Promise<readonly EventEnvelope[]>;
  readonly jobRow: (jobId: string) => Promise<(AiJobRow & Record<string, unknown>) | undefined>;
  readonly drain: () => Promise<void>;
}

const makeHarness = async (
  opts: { readonly providers?: readonly AiProviderPort[]; readonly withWorkroom?: boolean } = {},
): Promise<Harness> => {
  const engine: StorageEnginePort = await openEngine();
  const journal = createJournal(engine);
  const ledger = createIntentLedger({ engine, journal });
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  const scheduler = makeScheduler();
  let tick = 0;
  const ids = createIdGenerator({
    now: () => WALL + (tick += 1),
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  });
  let nowValue = WALL;
  const now = (): number => (nowValue += 1);
  const appender = createStreamAppender({ journal, projections, deviceId: DEV_A, ids, now });

  const sent: MessageEnvelope[] = [];
  let script: (env: MessageEnvelope, answer: (v: ValidatedMessage) => void) => boolean = () =>
    false;
  const inboxQueue: ValidatedMessage[] = [];
  let pair: ReturnType<typeof createWorkroomHostPair> | null = null;
  const doc = {
    outbox: sent,
    respond: (rule: typeof script) => {
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

  const h: Harness = {
    scheduler,
    doc,
    service: undefined as unknown as Harness['service'],
    events: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error('readRange failed');
      return r.value.events.map((e) => e.envelope);
    },
    artifactEvents: async () =>
      (await h.events()).filter((e) => e.type === 'MemoryArtifactWritten'),
    briefDismissedEvents: async () => (await h.events()).filter((e) => e.type === 'BriefDismissed'),
    jobRow: async (jobId) => {
      const r = await engine.txn(['ai_jobs'], 'readonly', async (tx) =>
        tx.table<AiJobRow & Record<string, unknown>>('ai_jobs').get(jobId),
      );
      if (!r.ok) throw new Error('row read failed');
      return r.value;
    },
    drain: async () => {
      for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
        scheduler.fire(0);
        await new Promise((r) => setTimeout(r, 0));
        await doc.answerAll();
      }
    },
  };

  if (opts.withWorkroom === true) {
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
    pair = createWorkroomHostPair({
      offscreen: fakeOffscreen,
      send: (m) => {
        sent.push(m);
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

  const queue = createAiJobQueue({ engine });
  const ladder = createAiLadder({
    providers: opts.providers ?? [createHeuristicNamer()],
  });
  const swLocal = createSwLocalWorkerHost({ ladder });
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
      backgroundOk: () => Promise.resolve(false),
    },
    scheduler,
  });
  return h;
};

describe('E8-T05 · absence law at the pump (terminal done, zero events, evidence counted)', () => {
  const THIN_BRIEF: MissionBriefInput = {
    tabCount: 2,
    rootDomains: ['misc.example'],
    takenAt: WALL,
    tabs: [
      { title: 'किताबें और कहानियाँ', rootDomain: 'books.example' },
      { title: 'some vague reading pile', rootDomain: 'misc.example' },
    ],
    lastActiveTitle: 'some page',
  };

  it('A4: thin brief attempt ⇒ done WITHOUT artifact; silentDone census sees it; no failure class', async () => {
    const h = await makeHarness({ providers: [createDeferredOnDeviceNamer(AMBIENT)] });
    const enq = await h.service.enqueueMissionBrief(
      { subjectId: testId(201), lane: 'maintenance', input: THIN_BRIEF },
      ctx,
    );
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    expect((await h.artifactEvents()).length).toBe(0); // absence law: NO event
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.['artifactRef']).toBeUndefined();
    expect(row?.['failureClass']).toBeUndefined();
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.queue.silentDone).toBe(1);
    expect(stats.value.queue.malformedRejected + stats.value.queue.invalidRejected).toBe(0);
  });

  it('A5: rich brief attempt ⇒ one artifact (kind mission-brief), verbatim text, no silence counted', async () => {
    const h = await makeHarness({ providers: [createDeferredOnDeviceNamer(AMBIENT)] });
    const enq = await h.service.enqueueMissionBrief(
      {
        subjectId: testId(202),
        lane: 'maintenance',
        input: briefInput(RICH_TITLES, { lastActive: 'Merged pull request on github' }),
      },
      ctx,
    );
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    const events = await h.artifactEvents();
    expect(events.length).toBe(1);
    const p = events[0]?.payload as Record<string, unknown>;
    expect(p['kind']).toBe('mission-brief');
    expect(p['provider']).toBe(ONDEVICE_PROVIDER_ID);
    expect(String(p['value'])).toContain('You stopped at Merged pull request on github.');
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).toBe('done');
    expect(row?.['artifactRef']).toBe(p['artifactId']);
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.queue.silentDone).toBe(0);
  });

  it('A6: stray silent over the wire on a NAME job is re-mapped to provider-error (classifier guard)', async () => {
    const h = await makeHarness({ withWorkroom: true });
    h.doc.respond((env, answer) => {
      if (env.name === 'EnsureWorkroom')
        answer(asValidated('WorkroomReady', { capabilitiesResolved: {} }));
      if (env.name === 'JobOffer') {
        const jobId = String((env.payload as Record<string, unknown>)['jobId']);
        answer(asValidated('JobClaimed', { jobId, workerTag: 'offscreen' }));
        // The lie: a silent class on mission-name (not absence-preferred).
        answer(asValidated('JobResult', { jobId, ok: false, failureClass: 'silent' }));
      }
      return true;
    });
    const enq = await h.service.enqueueMissionName(
      {
        subjectId: testId(203),
        lane: 'maintenance',
        input: { tabCount: 3, rootDomains: ['docs.example'], takenAt: WALL },
      },
      ctx,
    );
    if (!enq.ok) throw new Error('enqueue failed');
    await h.drain();
    expect((await h.artifactEvents()).length).toBe(0);
    const row = await h.jobRow(enq.value.jobId);
    expect(row?.state).not.toBe('done'); // never silenced — released/retried per error law
    const stats = await h.service.stats();
    if (!stats.ok) throw new Error('stats failed');
    expect(stats.value.queue.silentDone ?? 0).toBe(0);
  });
});

describe('E8-T05 · domain brief gate (D-series: §6.11 tier law, R18)', () => {
  it('D1: absence of artifact ⇒ absent; dismissal outranks any artifact', () => {
    expect(briefsGate({ dismissed: false }).kind).toBe('absent');
    expect(briefsGate({ dismissed: true }).kind).toBe('dismissed');
    expect(
      briefsGate({ artifact: { value: 'a brief', confidence: 0.88 }, dismissed: true }).kind,
    ).toBe('dismissed');
  });

  it('D2: tiers map to affordance words — high normal, medium suggested, LOW ⇒ ABSENT', () => {
    const high = briefsGate({
      artifact: { value: 'state. stopped.', confidence: 0.9 },
      dismissed: false,
    });
    expect(high).toEqual({ kind: 'show', text: 'state. stopped.', presentation: 'normal' });
    const mid = briefsGate({
      artifact: { value: 'state. stopped.', confidence: 0.72 },
      dismissed: false,
    });
    expect(mid).toEqual({ kind: 'show', text: 'state. stopped.', presentation: 'suggested' });
    // The brief-specific §6.11 law: neutral transform IS absence (no heuristic form exists).
    expect(
      briefsGate({ artifact: { value: 'state. stopped.', confidence: 0.55 }, dismissed: false })
        .kind,
    ).toBe('absent');
    expect(
      briefsGate({ artifact: { value: 'state. stopped.', confidence: 0.2 }, dismissed: false })
        .kind,
    ).toBe('absent');
  });

  it('D3: totality — non-string or empty values never reach a card', () => {
    expect(briefsGate({ artifact: { value: 42, confidence: 0.9 }, dismissed: false }).kind).toBe(
      'absent',
    );
    expect(briefsGate({ artifact: { value: '', confidence: 0.9 }, dismissed: false }).kind).toBe(
      'absent',
    );
  });
});

describe('E8-T05 · dismiss memory (E-series: preference, not deletion)', () => {
  const makePrefs = async () => {
    const engine: StorageEnginePort = await openEngine();
    const journal = createJournal(engine);
    const ids = createIdGenerator({
      now: () => WALL,
      randomBytes: (n: number) => new Uint8Array(n).fill(9),
    });
    let nowValue = WALL;
    const now = (): number => (nowValue += 1);
    const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
    const appender = createStreamAppender({ journal, projections, deviceId: DEV_A, ids, now });
    const deps = {
      engine,
      journal,
      projections,
      ids,
      deviceId: DEV_A,
      now,
    } as unknown as ServiceDeps;
    const prefs = createPrefsService({ deps, appender });
    const dismissed = async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error('readRange failed');
      return r.value.events.map((e) => e.envelope).filter((e) => e.type === 'BriefDismissed');
    };
    return { prefs, dismissed };
  };

  it('E1: dismiss commits ONE BriefDismissed, lawfully shaped (registry payload valid)', async () => {
    const { prefs, dismissed } = await makePrefs();
    const missionId = testId(301);
    const artifactId = testId(302);
    const done = await prefs.dismissMissionBrief({ missionId, briefArtifactId: artifactId }, ctx);
    if (!done.ok) throw new Error(`dismiss failed: ${done.error.code}`);
    const events = await dismissed();
    expect(events.length).toBe(1);
    const p = events[0]?.payload as Record<string, unknown>;
    expect(p['briefDismissalId']).toBe(done.value.briefDismissalId);
    expect(p['missionId']).toBe(missionId);
    expect(p['briefArtifactId']).toBe(artifactId);
    expect(typeof p['dismissedAt']).toBe('number');
    expect(validatePayload('BriefDismissed', p).ok).toBe(true);
  });

  it('E2: two dismissals of one mission converge (projection-level idempotence); artifacts stand', async () => {
    // The cid REDELIVERY dedupe is the intents-ledger's law (two distinct
    // commands are two intentions). Dismissal idempotence lives one layer up:
    // projections key suppressed state by missionId, so N stamps converge —
    // and the artifact row itself is never touched (preference, not deletion).
    const { prefs, dismissed } = await makePrefs();
    const missionId = testId(303);
    const first = await prefs.dismissMissionBrief({ missionId }, ctx);
    if (!first.ok) throw new Error('dismiss failed');
    const second = await prefs.dismissMissionBrief(
      { missionId },
      { ...ctx, cid: `${ctx.cid}-again` },
    );
    if (!second.ok) throw new Error('dismiss failed');
    const events = await dismissed();
    expect(events.length).toBe(2);
    const missions = events.map((e) => (e.payload as Record<string, unknown>)['missionId']);
    expect(new Set(missions).size).toBe(1);
    expect(new Set(missions).has(missionId)).toBe(true);
    expect(first.value.briefDismissalId).not.toBe(second.value.briefDismissalId);
  });

  it('E3: the registry covenant row is frozen (A-09 addition, Corrections producer)', () => {
    const row = EVENT_REGISTRY.BriefDismissed;
    expect(row.schemaV).toBe(1);
    expect(row.producer).toBe('Corrections');
    expect(row.idempotentBy).toBe('briefDismissalId');
    expect(row.consumers).toEqual(['MissionsView', 'MemoryView']);
    expect(row.fields).toEqual({
      briefDismissalId: 'id',
      missionId: 'id',
      dismissedAt: 'number',
      'briefArtifactId?': 'id',
    });
  });

  it('E4: an empty mission id is a legality rejection, never a write', async () => {
    const { prefs, dismissed } = await makePrefs();
    const bad = await prefs.dismissMissionBrief({ missionId: '   ' }, ctx);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('E_DOMAIN_LEGALITY');
    expect((await dismissed()).length).toBe(0);
  });
});

describe('E8-T05 · v1.1 wire reserve (C-series: frozen shape, dormant today)', () => {
  it('C1: DismissBrief + GetMissionBrief are registered at v1.1 and ignored as unavailable-name', () => {
    expect(MESSAGE_REGISTRY['DismissBrief']?.availability).toBe('v1.1');
    expect(MESSAGE_REGISTRY['DismissBrief']?.payload).toEqual({
      missionId: 'id',
      'briefArtifactId?': 'id',
    });
    expect(MESSAGE_REGISTRY['GetMissionBrief']?.availability).toBe('v1.1');
    expect(MESSAGE_REGISTRY['GetMissionBrief']?.response).toEqual({
      'text?': 'string',
      'presentation?': 'string',
    });
    const command: MessageEnvelope = {
      v: CONTRACT_V,
      kind: 'command',
      name: 'DismissBrief',
      cid: nextCid(),
      senderContext: 'guardian',
      payload: { missionId: testId(401) },
      contractHash: computeContractHash(),
    };
    const outcome = validateMessage(command, { zone: 'zone0' });
    expect(outcome.type).toBe('ignored');
    if (outcome.type === 'ignored') {
      expect(outcome.reason).toBe('unavailable-name');
      expect(outcome.availability).toBe('v1.1');
    }
    const query: MessageEnvelope = { ...command, kind: 'query', name: 'GetMissionBrief' };
    const ignoredQuery = validateMessage(query, { zone: 'zone0' });
    expect(ignoredQuery.type).toBe('ignored');
  });
});
