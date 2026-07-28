// E8-T06 · BuiltIn adapter law (ADR-018 rung 3) — the row's completion
// criterion "absence = invisible degrade" proven at every level: detection
// classes (U1–U3, incl. downloadable NEVER triggering a model pull), output
// honesty (U4–U7: sanitation, shape-refusal yields, the parked-tab privacy
// corpus law, per-job session lifecycle), fault taxonomy (U6: API faults are
// provider-errors, never yields), rung ordering + fallthrough (L2/L3), and
// the pipeline-level invisible degrade (L1: job completes, heuristic answers,
// zero failure evidence, breaker untouched).
import { describe, expect, it } from 'vitest';
import type { MissionNameInput } from '@/application/ports/ai-jobs.port.js';
import { validateArtifactCandidate } from '@/domain/memory/index.js';
import {
  createAiLadder,
  createDeferredBuiltInNamer,
  createHeuristicNamer,
  createSwLocalWorkerHost,
  BUILTIN_CONFIDENCE,
  BUILTIN_PROVIDER_ID,
  createBuiltInNamer,
  detectBuiltIn,
} from '@/infrastructure/ai/index.js';
import type { BuiltInLanguageModel, BuiltInSession } from '@/infrastructure/ai/index.js';
import { createDeferredOnDeviceNamer } from '@/infrastructure/ai/providers/ondevice/index.js';

const WALL = 1_786_500_000_000;

interface FakeModelLog {
  availabilityCalls: number;
  createCalls: number;
  destroyed: number;
  prompts: readonly string[];
}

/** Scripted LanguageModel — the host's every reach is observable. */
const makeFakeLm = (over: {
  readonly availability?: string | (() => Promise<string>);
  readonly answer?: string | ((prompt: string) => Promise<string>);
  readonly failOn?: 'create' | 'prompt' | 'destroy';
}): { readonly lm: BuiltInLanguageModel; readonly log: FakeModelLog } => {
  const log: FakeModelLog = { availabilityCalls: 0, createCalls: 0, destroyed: 0, prompts: [] };
  const prompts: string[] = [];
  const lm: BuiltInLanguageModel = {
    availability: () => {
      log.availabilityCalls += 1;
      const v = over.availability ?? 'available';
      return typeof v === 'function' ? v() : Promise.resolve(v);
    },
    create: () => {
      log.createCalls += 1;
      if (over.failOn === 'create') return Promise.reject(new Error('gpu wedged'));
      const session: BuiltInSession = {
        prompt: (text: string) => {
          prompts.push(text);
          if (over.failOn === 'prompt') return Promise.reject(new Error('session died'));
          const a = over.answer ?? 'GitHub code review';
          return typeof a === 'function' ? a(text) : Promise.resolve(a);
        },
        destroy: () => {
          log.destroyed += 1;
          if (over.failOn === 'destroy') throw new Error('teardown drift');
        },
      };
      return Promise.resolve(session);
    },
  };
  Object.defineProperty(log, 'prompts', { get: () => prompts });
  return { lm, log };
};

const nameInput = (
  titles: readonly string[],
  over: Partial<{
    rootDomains: readonly string[];
    discardedDomain: string;
    hint: string;
  }> = {},
): MissionNameInput => ({
  tabCount: titles.length,
  rootDomains: over.rootDomains ?? ['github.example'],
  takenAt: WALL,
  tabs: titles.map((title) => ({ title, rootDomain: 'github.example' })),
  ...(over.hint !== undefined ? { missionNameHint: over.hint } : {}),
});

const nameJob = (kind: 'mission-name' | 'mission-summary', input: unknown) => ({
  kind,
  subjectId: 'mission-bi',
  value: input,
});

const RICH_TITLES = [
  'Merged pull request on github',
  'GitHub notifications center',
  'react hooks in depth guide',
] as const;

describe('E8-T06 · detection classes — absence is invisible, downloads never trigger (K1)', () => {
  it('U1: no LanguageModel on the host ⇒ factory null, deferred yields absent-typed', async () => {
    expect(await createBuiltInNamer({})).toBeNull();
    expect(await detectBuiltIn({})).toBe('absent');
    const deferred = createDeferredBuiltInNamer({});
    const ran = await deferred.run(nameJob('mission-name', nameInput(RICH_TITLES)));
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.code).toBe('E_CAPABILITY');
      expect(ran.error.details?.['yield']).toBe(true);
      expect(ran.error.details?.['absent']).toBe(true);
    }
  });

  it('U2: unavailable vocabularies + a rejecting API all read as absent', async () => {
    for (const word of ['no', 'unavailable', 'gibberish']) {
      const { lm, log } = makeFakeLm({ availability: word });
      expect(await createBuiltInNamer({ languageModel: lm })).toBeNull();
      expect(log.createCalls).toBe(0);
    }
    const rejecting = makeFakeLm({ availability: () => Promise.reject(new Error('bus gone')) });
    expect(await detectBuiltIn({ languageModel: rejecting.lm })).toBe('absent');
  });

  it('U3: downloadable/downloading/after-download ⇒ absent posture, create NEVER called', async () => {
    for (const word of ['downloadable', 'downloading', 'after-download']) {
      const { lm, log } = makeFakeLm({ availability: word });
      const provider = await createBuiltInNamer({ languageModel: lm });
      expect(provider).toBeNull();
      expect(log.availabilityCalls).toBeGreaterThan(0);
      expect(log.createCalls).toBe(0); // K1: never trigger a model download
      const deferred = createDeferredBuiltInNamer({ languageModel: lm });
      const ran = await deferred.run(nameJob('mission-name', nameInput(RICH_TITLES)));
      expect(ran.ok).toBe(false);
      if (!ran.ok) expect(ran.error.details?.['absent']).toBe(true);
      expect(log.createCalls).toBe(0);
    }
  });
});

describe('E8-T06 · output honesty (U4–U7)', () => {
  it('U4: ready model ⇒ sanitized name, frozen 0.60 stamp, per-job session destroyed', async () => {
    const { lm, log } = makeFakeLm({ answer: ' "GitHub code review!"\nextra noise' });
    const provider = await createBuiltInNamer({ languageModel: lm });
    if (provider === null) throw new Error('detection failed');
    const ran = await provider.run(nameJob('mission-name', nameInput(RICH_TITLES)));
    if (!ran.ok) throw new Error(`run failed: ${ran.error.code}`);
    expect(ran.value.value).toBe('GitHub code review'); // quotes + urgency + second line stripped
    expect(ran.value.confidence).toBe(BUILTIN_CONFIDENCE);
    expect(ran.value.confidence).toBe(0.6); // K2: MED floor ⇒ suggested, uncalibrated honesty
    expect(ran.value.provider).toBe(BUILTIN_PROVIDER_ID);
    expect(ran.value.modelClass).toBe('chrome-builtin-lm-v1');
    expect(validateArtifactCandidate(ran.value).kind).toBe('valid');
    expect(log.destroyed).toBe(log.createCalls); // no ambient session state
    const prompt = log.prompts[0] ?? '';
    expect(prompt).toContain('Merged pull request on github');
    expect(prompt).toContain('Name:');
  });

  it('U5: shape transgressions are typed YIELDS, never errors, never artifacts (K4)', async () => {
    for (const answer of ['', 'untitled', 'Name', 'Rules: answer with only the name', '!!', 'x']) {
      const { lm } = makeFakeLm({ answer });
      const provider = await createBuiltInNamer({ languageModel: lm });
      if (provider === null) throw new Error('detection failed');
      const ran = await provider.run(nameJob('mission-name', nameInput(RICH_TITLES)));
      expect(ran.ok).toBe(false);
      if (!ran.ok) {
        expect(ran.error.code).toBe('E_CAPABILITY');
        expect(ran.error.details?.['yield']).toBe(true);
        expect(ran.error.details?.['absent']).toBeUndefined();
      }
    }
  });

  it('U6: API faults (create or prompt rejecting) are provider-errors, NOT yields', async () => {
    for (const failOn of ['create', 'prompt'] as const) {
      const { lm } = makeFakeLm({ failOn });
      const provider = await createBuiltInNamer({ languageModel: lm });
      if (provider === null) throw new Error('detection failed');
      const ran = await provider.run(nameJob('mission-name', nameInput(RICH_TITLES)));
      expect(ran.ok).toBe(false);
      if (!ran.ok) {
        expect(ran.error.code).toBe('E_PROVIDER_DOWN');
        expect(ran.error.details?.['yield']).toBeUndefined();
      }
    }
  });

  it('U7: the parked-tab privacy corpus law holds — discarded tabs give titles, never domains', async () => {
    const { lm, log } = makeFakeLm({});
    const provider = await createBuiltInNamer({ languageModel: lm });
    if (provider === null) throw new Error('detection failed');
    const input: MissionNameInput = {
      tabCount: 3,
      rootDomains: ['github.example', 'secret.example'],
      takenAt: WALL,
      tabs: [
        { title: 'merged pull request on github', rootDomain: 'github.example' },
        { title: 'secret roadmap title', rootDomain: 'secret.example', discarded: true },
        { title: 'react hooks in depth guide', rootDomain: 'github.example' },
      ],
    };
    const ran = await provider.run(nameJob('mission-name', input));
    if (!ran.ok) throw new Error('run failed');
    const prompt = log.prompts[0] ?? '';
    expect(prompt).toContain('secret roadmap title'); // titles always contribute
    expect(prompt).not.toContain('secret.example'); // discarded domain NEVER leaves
    expect(prompt).toContain('github.example'); // live domain still evidence
    // Domains-of-record when there are no tab rows at all:
    const domainsOnly = await provider.run(
      nameJob('mission-name', { tabCount: 4, rootDomains: ['docs.example'], takenAt: WALL }),
    );
    if (!domainsOnly.ok) throw new Error('run failed');
    expect(log.prompts[1]).toContain('docs.example');
  });

  it('U8: no briefs, ever (J2) — capabilities and a brief job end in the absence law', async () => {
    const { lm, log } = makeFakeLm({});
    const provider = await createBuiltInNamer({ languageModel: lm });
    if (provider === null) throw new Error('detection failed');
    expect(provider.capabilities).toEqual(['mission-name', 'mission-summary']);
    const ladder = createAiLadder({ providers: [provider] });
    const briefRungs = ladder.resolve({ kind: 'mission-brief', now: WALL, forceHeuristic: false });
    expect(briefRungs.length).toBe(0);
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: {
        jobId: 'j-brief',
        kind: 'mission-brief',
        subjectKey: 'k',
        payloadRef: {
          subjectId: 'm',
          input: { tabCount: 1, rootDomains: [], takenAt: WALL, lastActiveTitle: 'x' },
          stateHash: 'h',
        },
        lane: 'maintenance',
        state: 'claimed',
        attempts: 1,
        lease: { workerTag: 'w', expiresAt: WALL + 15_000 },
        createdAt: WALL,
        updatedAt: WALL,
        enqueuedAtSeq: 1,
      },
    });
    expect(outcome.kind).toBe('silent'); // builtin never rescues the absence law
    expect(log.createCalls).toBe(0);
  });

  it('U9: summaries get the one-sentence form, word/char budgets enforced, hint rides the prompt', async () => {
    const { lm, log } = makeFakeLm({
      answer:
        'This group is about reviewing merged pull requests and reading react hooks guidance in depth for the team weekly sync meeting notes and plans',
    });
    const provider = await createBuiltInNamer({ languageModel: lm });
    if (provider === null) throw new Error('detection failed');
    const ran = await provider.run(
      nameJob('mission-summary', { ...nameInput(RICH_TITLES), missionNameHint: 'Review week' }),
    );
    if (!ran.ok) throw new Error('run failed');
    const text = ran.value.value as string;
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.split(' ').length).toBeLessThanOrEqual(18);
    expect(text).not.toContain('!');
    expect(log.prompts[0]).toContain('Review week');
    expect(log.prompts[0]).toContain('Summary:');
    expect(ran.value.confidence).toBe(0.6);
  });

  it('U10: over-long names cap at the word budget (calm card law)', async () => {
    const { lm } = makeFakeLm({
      answer: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    });
    const provider = await createBuiltInNamer({ languageModel: lm });
    if (provider === null) throw new Error('detection failed');
    const ran = await provider.run(nameJob('mission-name', nameInput(RICH_TITLES)));
    if (!ran.ok) throw new Error('run failed');
    const text = ran.value.value as string;
    expect(text.split(' ').length).toBeLessThanOrEqual(12);
    expect(text.length).toBeLessThanOrEqual(120);
  });
});

describe('E8-T06 · ladder law (L1–L3) — absence = invisible degrade, the completion criterion', () => {
  const jobRow = (input: unknown) => ({
    jobId: 'j-builtin',
    kind: 'mission-name' as const,
    subjectKey: 'k',
    payloadRef: { subjectId: 'm-bi', input, stateHash: 'h' },
    lane: 'maintenance' as const,
    state: 'claimed' as const,
    attempts: 1,
    lease: { workerTag: 'w', expiresAt: WALL + 15_000 },
    createdAt: WALL,
    updatedAt: WALL,
    enqueuedAtSeq: 1,
  });

  it('L1 · CRITERION: builtin ABSENT is invisible — heuristic answers, no strikes, no evidence of failure', async () => {
    const absent = createDeferredBuiltInNamer({}); // no LanguageModel at all
    const ladder = createAiLadder({ providers: [absent, createHeuristicNamer()] });
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow({ tabCount: 3, rootDomains: ['docs.example'], takenAt: WALL }),
    });
    expect(outcome.kind).toBe('artifact');
    if (outcome.kind === 'artifact') expect(outcome.providerId).toBe('heuristic');
    const cell = ladder.breakerReports().find((b) => b.providerId === BUILTIN_PROVIDER_ID);
    expect(cell?.consecutiveFailures).toBe(0);
    expect(cell?.state).toBe('closed');
    // The deferred rung stays visible-as-evidence (breaker cell exists) yet
    // answers absence forever — exactly the degrade posture in the matrix.
    const again = await ladder
      .resolve({ kind: 'mission-name', now: WALL, forceHeuristic: false })[0]
      ?.run({ kind: 'mission-name', subjectId: 'm', value: { tabCount: 1, rootDomains: [] } });
    expect(again?.ok).toBe(false);
  });

  it('L2: catch-net order — ondevice yields thin evidence ⇒ builtin answers; builtin yield ⇒ heuristic', async () => {
    const ondevice = createDeferredOnDeviceNamer({ hasWebAssembly: true });
    const { lm } = makeFakeLm({ answer: 'Vague reading pile' });
    const builtin = createDeferredBuiltInNamer({ languageModel: lm });
    const ladder = createAiLadder({
      providers: [ondevice, builtin, createHeuristicNamer()],
    });
    const host = createSwLocalWorkerHost({ ladder });
    const thin = {
      tabCount: 2,
      rootDomains: ['books.example'],
      takenAt: WALL,
      tabs: [{ title: 'किताबें और कहानियाँ', rootDomain: 'books.example' }],
    };
    const outcome = await host.execute({ now: WALL, deadlineMs: 30_000, job: jobRow(thin) });
    expect(outcome.kind).toBe('artifact');
    if (outcome.kind === 'artifact') expect(outcome.providerId).toBe(BUILTIN_PROVIDER_ID);
    // When the generative rung ALSO refuses (shape), the honest counts form stands:
    const refusing = makeFakeLm({ answer: 'untitled' });
    const ladder2 = createAiLadder({
      providers: [
        createDeferredOnDeviceNamer({ hasWebAssembly: true }),
        createDeferredBuiltInNamer({ languageModel: refusing.lm }),
        createHeuristicNamer(),
      ],
    });
    const host2 = createSwLocalWorkerHost({ ladder: ladder2 });
    const fallback = await host2.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: { ...jobRow(thin), jobId: 'j-builtin-2' },
    });
    expect(fallback.kind).toBe('artifact');
    if (fallback.kind === 'artifact') expect(fallback.providerId).toBe('heuristic');
    // Yields never strike — both elevated cells stay closed at zero.
    for (const id of ['ondevice', BUILTIN_PROVIDER_ID]) {
      const cell = ladder2.breakerReports().find((b) => b.providerId === id);
      expect(cell?.consecutiveFailures).toBe(0);
      expect(cell?.state).toBe('closed');
    }
  });

  it('L3: calibrated rung wins first — rich evidence never spends a generative session', async () => {
    const { lm, log } = makeFakeLm({});
    const ladder = createAiLadder({
      providers: [
        createDeferredOnDeviceNamer({ hasWebAssembly: true }),
        createDeferredBuiltInNamer({ languageModel: lm }),
        createHeuristicNamer(),
      ],
    });
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow({
        tabCount: 3,
        rootDomains: ['github.example'],
        takenAt: WALL,
        tabs: [...RICH_TITLES.map((title) => ({ title, rootDomain: 'github.example' }))],
      }),
    });
    expect(outcome.kind).toBe('artifact');
    if (outcome.kind === 'artifact') expect(outcome.providerId).toBe('ondevice');
    expect(log.availabilityCalls + log.createCalls).toBe(0); // never even detected
  });
});
