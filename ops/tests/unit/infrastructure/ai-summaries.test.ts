// E8-T04 · mission summaries law (Spec §6.3, Blueprint §6.15): the on-device
// rung's one-liner + thread honesty, the typed yields, the HEURISTIC fail-down
// form (the row's completion criterion — "heuristic when low-fidelity"),
// budget discipline, parked-tab privacy, and the artifact covenant.
import { describe, expect, it } from 'vitest';
import type { AiJobRow, MissionSummaryInput } from '@/application/ports/ai-jobs.port.js';
import { validateArtifactCandidate } from '@/domain/memory/index.js';
import { createAiLadder, createSwLocalWorkerHost } from '@/infrastructure/ai/index.js';
import { HEURISTIC_NAMER_CONFIDENCE, createHeuristicNamer } from '@/infrastructure/ai/index.js';
import {
  createDeferredOnDeviceNamer,
  createOnDeviceNamer,
  ONDEVICE_PROVIDER_ID,
} from '@/infrastructure/ai/providers/ondevice/index.js';
import { EVENT_REGISTRY } from '@/shared-kernel/events/events.registry.js';

const AMBIENT = { hasWebAssembly: true } as const;
const WALL = 1_786_300_000_000;

const summaryInput = (
  titles: readonly string[],
  rootDomains: readonly string[] = [],
  hint?: string,
): MissionSummaryInput => ({
  tabCount: titles.length,
  rootDomains,
  takenAt: WALL,
  tabs: titles.map((title) => ({ title, rootDomain: '' })),
  ...(hint !== undefined ? { missionNameHint: hint } : {}),
});

const summaryJob = (input: MissionSummaryInput) => ({
  kind: 'mission-summary' as const,
  subjectId: 'mission-s',
  value: input,
});

const RICH_TITLES = [
  'Merged pull request on github',
  'GitHub notifications center',
  'react hooks in depth guide',
  'React 19 features overview',
] as const;

describe('E8-T04 · on-device summary honesty', () => {
  it('S1: rich evidence ⇒ named one-liner + thread, calibrated and replay-stable', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ran = await provider.run(
      summaryJob(summaryInput(RICH_TITLES, ['github.example', 'reactjs.example'])),
    );
    if (!ran.ok) throw new Error(`run failed: ${ran.error.code}`);
    const candidate = ran.value;
    expect(candidate.provider).toBe(ONDEVICE_PROVIDER_ID);
    expect(candidate.modelClass).toBe('ondevice-fwd-v1');
    expect(candidate.confidence).toBe(0.88); // dual sharp stamp (same machine law)
    expect(typeof candidate.value).toBe('string');
    const oneLiner = candidate.value as string;
    expect(oneLiner.startsWith('GitHub & React')).toBe(true);
    expect(oneLiner.length).toBeLessThanOrEqual(120);
    expect(oneLiner).toContain('2 domains');
    expect(typeof candidate.thread).toBe('string');
    const thread = candidate.thread ?? '';
    expect(thread).toContain('4 tabs across 2 domains');
    expect(thread).toContain('strongest evidence centers on GitHub & React');
    expect(thread).toContain('parked at ');
    // Replay idempotence (chaos/redelivery class): byte-equal answer.
    const again = await provider.run(
      summaryJob(summaryInput(RICH_TITLES, ['github.example', 'reactjs.example'])),
    );
    if (!again.ok) throw new Error('replay failed');
    expect(again.value).toEqual(candidate);
  });

  it('S2: honest vocabulary — every anchor term is a kernel-confirmed evidence token', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ran = await provider.run(summaryJob(summaryInput(RICH_TITLES, ['github.example'])));
    if (!ran.ok) throw new Error('run failed');
    const oneLiner = ran.value.value as string;
    const anchorsMatch = / — anchors: (.+)$/.exec(oneLiner);
    if (anchorsMatch === null) throw new Error(`no anchors clause in: ${oneLiner}`);
    const anchors = anchorsMatch[1]?.split(/, | and /) ?? [];
    const allowed = new Set([
      'github',
      'pull request',
      'merged',
      'commit',
      'diff',
      'react',
      'jsx',
      'hooks',
      'next js',
      'nextjs',
      'component',
    ]);
    for (const anchor of anchors) expect(allowed.has(anchor)).toBe(true);
  });

  it('S3: thin evidence YIELDS typed (the fail-down trigger — never shallow prose)', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ran = await provider.run(
      summaryJob(summaryInput(['सपना देखना एक अच्छी बात है', 'random daily scroll'])),
    );
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.code).toBe('E_CAPABILITY');
      expect(ran.error.details?.['yield']).toBe(true);
      expect(ran.error.details?.['absent']).toBeUndefined();
    }
  });

  it('S4: capability absence ⇒ async factory null; deferred rung yields absent-typed', async () => {
    const none = { hasWebAssembly: false };
    expect(await createOnDeviceNamer(none)).toBeNull();
    const deferred = createDeferredOnDeviceNamer(none);
    const ran = await deferred.run(summaryJob(summaryInput(RICH_TITLES)));
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.details?.['yield']).toBe(true);
      expect(ran.error.details?.['absent']).toBe(true);
    }
  });

  it('S5: name hint rides the thread, capped; the summary artifact passes the boundary law', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const hint = 'GitHub spelunking — the definitive expedition record number seven';
    const ran = await provider.run(summaryJob(summaryInput(RICH_TITLES, ['github.example'], hint)));
    if (!ran.ok) throw new Error('run failed');
    expect(ran.value.thread).toContain(`Name on record: ${hint}.`);
    const hintOver = 'x'.repeat(500);
    const ranOver = await provider.run(summaryJob(summaryInput(RICH_TITLES, [], hintOver)));
    if (!ranOver.ok) throw new Error('run failed');
    const recorded = /Name on record: (x+)\./.exec(ranOver.value.thread ?? '');
    expect(recorded?.[1]?.length).toBe(120); // port cap enforced in the provider
    const verdict = validateArtifactCandidate(ran.value);
    expect(verdict.kind).toBe('valid');
    if (verdict.kind === 'valid') expect(verdict.artifact.thread).toBe(ran.value.thread);
  });
});

describe('E8-T04 · heuristic fail-down form (counts truth, §6.3 failure law)', () => {
  it('H1: always answers, LOW-band stamp, structure stable', async () => {
    const heuristic = createHeuristicNamer();
    const input: MissionSummaryInput = {
      tabCount: 4,
      rootDomains: ['github.example', 'mail.example'],
      takenAt: WALL,
      tabs: [
        { title: 'a', rootDomain: 'github.example' },
        { title: 'b', rootDomain: 'github.example' },
        { title: 'c', rootDomain: 'github.example' },
        { title: 'd', rootDomain: 'mail.example' },
      ],
    };
    const ran = await heuristic.run(summaryJob(input));
    if (!ran.ok) throw new Error('run failed');
    expect(ran.value.confidence).toBe(HEURISTIC_NAMER_CONFIDENCE);
    expect(ran.value.modelClass).toBe('heuristic-domain-time-v1');
    const oneLiner = ran.value.value as string;
    expect(oneLiner).toContain('4 tabs across 2 domains');
    expect(oneLiner).toContain('largest presence github (3 tabs)');
    expect(ran.value.thread).toContain('This 4-tab record spans 2 domains.');
    expect(ran.value.thread).toContain('Domain family github appears most (3 tabs).');
    expect(ran.value.thread).toContain('Parked at ');
  });

  it('H2: hint prefixes the one-liner and rides the thread', async () => {
    const heuristic = createHeuristicNamer();
    const ran = await heuristic.run(
      summaryJob(summaryInput(['anything', 'else'], ['x.example'], 'My saved expedition')),
    );
    if (!ran.ok) throw new Error('run failed');
    expect((ran.value.value as string).startsWith('My saved expedition — ')).toBe(true);
    expect(ran.value.thread).toContain('Name on record: My saved expedition.');
  });

  it('H3: no tabs ⇒ domains-of-record form; empty domains ⇒ honest "no domains"', async () => {
    const heuristic = createHeuristicNamer();
    const withDomains = await heuristic.run(
      summaryJob({ tabCount: 0, rootDomains: ['docs.example'], takenAt: WALL }),
    );
    if (!withDomains.ok) throw new Error('run failed');
    expect(withDomains.value.value).toContain('0 tabs across 1 domain');
    const empty = await heuristic.run(summaryJob({ tabCount: 3, rootDomains: [], takenAt: WALL }));
    if (!empty.ok) throw new Error('run failed');
    expect(empty.value.value).toContain('3 tabs · no domains');
    expect(empty.value.thread).toContain('no domains on record');
  });

  it('H4: parked-tab privacy — discarded tabs never enter the presence tally', async () => {
    const heuristic = createHeuristicNamer();
    const input: MissionSummaryInput = {
      tabCount: 3,
      rootDomains: ['live.example', 'secret.example'],
      takenAt: WALL,
      tabs: [
        { title: 'live page', rootDomain: 'live.example' },
        { title: 'secret page', rootDomain: 'secret.example', discarded: true },
        { title: 'another live', rootDomain: 'live.example' },
      ],
    };
    const ran = await heuristic.run(summaryJob(input));
    if (!ran.ok) throw new Error('run failed');
    expect(ran.value.value).toContain('across 1 domain');
    expect(ran.value.value).toContain('largest presence live (2 tabs)');
    expect(JSON.stringify(ran.value)).not.toContain('secret');
  });

  it('H5: budget law — the one-liner never exceeds 120 chars, never cuts mid-count', async () => {
    const heuristic = createHeuristicNamer();
    const input: MissionSummaryInput = {
      tabCount: 9,
      rootDomains: ['alpha.example', 'beta.example'],
      takenAt: WALL,
      missionNameHint: 'a'.repeat(118),
    };
    const ran = await heuristic.run(summaryJob(input));
    if (!ran.ok) throw new Error('run failed');
    const oneLiner = ran.value.value as string;
    expect(oneLiner.length).toBeLessThanOrEqual(120);
    // The hint is dropped before any mid-field cut; the counts always survive.
    expect(oneLiner).toContain('9 tabs across 2 domains');
  });
});

describe('E8-T04 · pipeline integration', () => {
  const jobRow = (input: unknown): AiJobRow => ({
    jobId: 'job-sum',
    kind: 'mission-summary',
    subjectKey: 'k',
    payloadRef: { subjectId: 'mission-sum', input, stateHash: 'h' },
    lane: 'maintenance',
    state: 'claimed',
    attempts: 1,
    lease: { workerTag: 'w', expiresAt: WALL + 15_000 },
    createdAt: WALL,
    updatedAt: WALL,
    enqueuedAtSeq: 3,
  });

  it('L1 · COMPLETION CRITERION: low-fidelity evidence ⇒ heuristic answers, and a yield never strikes the breaker', async () => {
    const deferred = createDeferredOnDeviceNamer({ hasWebAssembly: true });
    const ladder = createAiLadder({ providers: [deferred, createHeuristicNamer()] });
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow({
        tabCount: 2,
        rootDomains: ['misc.example'],
        takenAt: WALL,
        tabs: [
          { title: 'किताबें और कहानियाँ', rootDomain: 'books.example' },
          { title: 'some vague reading pile', rootDomain: 'misc.example' },
        ],
      }),
    });
    expect(outcome.kind).toBe('artifact');
    if (outcome.kind === 'artifact') {
      expect(outcome.providerId).toBe('heuristic');
      const candidate = outcome.candidate as { value: string; thread?: string };
      expect(candidate.value).toContain('2 tabs across 2 domains');
      expect(candidate.thread).toContain('Parked at ');
    }
    const cell = ladder.breakerReports().find((b) => b.providerId === ONDEVICE_PROVIDER_ID);
    expect(cell?.consecutiveFailures).toBe(0);
    expect(cell?.state).toBe('closed');
  });

  it('L2: kind-keyed ladder — summary jobs skip rungs that only name', async () => {
    const provider = await createOnDeviceNamer(AMBIENT);
    if (provider === null) throw new Error('model unavailable');
    const ladder = createAiLadder({ providers: [provider, createHeuristicNamer()] });
    const now = WALL;
    const summaryRungs = ladder.resolve({ kind: 'mission-summary', now, forceHeuristic: false });
    expect(summaryRungs.map((p) => p.providerId)).toEqual([ONDEVICE_PROVIDER_ID, 'heuristic']);
    const nameRungs = ladder.resolve({ kind: 'mission-name', now, forceHeuristic: false });
    expect(nameRungs.map((p) => p.providerId)).toEqual([ONDEVICE_PROVIDER_ID, 'heuristic']);
    const forced = ladder.resolve({ kind: 'mission-summary', now, forceHeuristic: true });
    expect(forced.map((p) => p.providerId)).toEqual(['heuristic']);
  });

  it('L3: the events covenant carries the additive thread field (A-09)', () => {
    const fields = EVENT_REGISTRY.MemoryArtifactWritten.fields as Readonly<Record<string, string>>;
    expect(fields['thread?']).toBe('string');
    expect(fields['value']).toBe('string'); // one-liner stays THE value
    expect(EVENT_REGISTRY.MemoryArtifactWritten.schemaV).toBe(1);
  });
});

describe('E8-T04 · domain boundary for the thread field', () => {
  const base = {
    value: 'a one-liner',
    confidence: 0.72,
    provider: 'ondevice',
    modelClass: 'ondevice-fwd-v1',
    schemaV: 1,
  };
  it('D1: thread accepted when well-formed; naming artifacts (no thread) untouched', () => {
    const withThread = validateArtifactCandidate({ ...base, thread: 'a narrative.' });
    expect(withThread.kind).toBe('valid');
    if (withThread.kind === 'valid') expect(withThread.artifact.thread).toBe('a narrative.');
    const without = validateArtifactCandidate(base);
    expect(without.kind).toBe('valid');
    if (without.kind === 'valid') expect(without.artifact.thread).toBeUndefined();
  });
  it('D2: empty thread is a lie about absence; over-budget is out of law', () => {
    const empty = validateArtifactCandidate({ ...base, thread: '' });
    expect(empty.kind).toBe('rejected');
    if (empty.kind === 'rejected') expect(empty.what).toBe('thread-empty');
    const over = validateArtifactCandidate({ ...base, thread: 'x'.repeat(2_001) });
    expect(over.kind).toBe('rejected');
    if (over.kind === 'rejected') expect(over.what).toBe('thread-over-budget');
  });
});
