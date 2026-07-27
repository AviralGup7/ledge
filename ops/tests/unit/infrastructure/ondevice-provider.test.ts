// E8-T03 · the on-device provider law (ops lane, unit project) — real shipped
// bytes through the real loader: model verification, kernel-vs-reference
// agreement, capability-absence invisibility, typed yields without breaker
// strikes, calibrated names, and the §5.13 honesty vocabulary.
import { describe, expect, it } from 'vitest';
import { validateArtifactCandidate } from '@/domain/memory/index.js';
import {
  FRAME_KERNEL_SHA256,
  FRAME_KERNEL_WASM_B64,
} from '@/infrastructure/ai/providers/ondevice/model/index.js';
import { NEEDLE_BASE, TEXT_PTR } from '@/infrastructure/ai/providers/ondevice/model-layout.js';
import { loadOnDeviceModel } from '@/infrastructure/ai/providers/ondevice/model-load.js';
import {
  calibrate,
  matchPhraseReference,
  normalizeText,
  ONDEVICE_ACCEPT_POSTERIOR,
} from '@/infrastructure/ai/providers/ondevice/score.js';
import {
  createDeferredOnDeviceNamer,
  createOnDeviceNamer,
  ONDEVICE_PROVIDER_ID,
} from '@/infrastructure/ai/providers/ondevice/index.js';
import {
  createAiLadder,
  createHeuristicNamer,
  createSwLocalWorkerHost,
} from '@/infrastructure/ai/index.js';
import type { AiJobRow } from '@/application/ports/ai-jobs.port.js';

const AMBIENT = { hasWebAssembly: true } as const;
const WALL = 1_786_300_000_000;

const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

const namingInput = (titles: readonly string[], rootDomains: readonly string[] = []) => ({
  subjectId: 'mission-x',
  kind: 'mission-name' as const,
  value: {
    tabCount: titles.length,
    rootDomains,
    takenAt: WALL,
    tabs: titles.map((title) => ({ title, rootDomain: '' })),
  },
});

describe('E8-T03 · model verify + machine truth', () => {
  it('M1: shipped bytes pass digest+validate+instantiate and stage needles inside the layout', async () => {
    const loaded = await loadOnDeviceModel(AMBIENT);
    if (!loaded.ok) throw new Error(`load failed: ${loaded.error.code}`);
    expect(loaded.value.weights.frames.length).toBeGreaterThan(0);
    expect(NEEDLE_BASE + loaded.value.weights.textBlob.length).toBeLessThanOrEqual(TEXT_PTR);
  });

  it('M2: the WASM machine AGREES with the JS reference over corpus × lexicon terms', async () => {
    const loaded = await loadOnDeviceModel(AMBIENT);
    if (!loaded.ok) throw new Error('load failed');
    const { kernel, weights } = loaded.value;
    const corpora = [
      'a react js framework for 2024 with github pull requests',
      'retrospective notes about the docker rollout and kubernetes',
      'quarterly budget ledger and invoice review with calendar',
      'service worker internals in chromium v8 extension apis',
      normalizeText('Café Übermensch — Déjà Vu · pull  request!'),
      '提ि ت こんにちは مرحبا',
    ];
    let checks = 0;
    for (const raw of corpora) {
      const corpus = normalizeText(raw);
      new Uint8Array(kernel.memory.buffer).set(new TextEncoder().encode(corpus), TEXT_PTR);
      for (const frame of weights.frames) {
        for (const term of frame.terms) {
          const machine = kernel.matchPtr(
            TEXT_PTR,
            new TextEncoder().encode(corpus).length,
            NEEDLE_BASE + term.off,
            term.len,
          );
          const reference = matchPhraseReference(corpus, term.text);
          expect(machine >= 0).toBe(reference);
          checks += 1;
        }
      }
    }
    expect(checks).toBeGreaterThan(100); // the gate is real, not a sample
  });

  it('M3: digest sabotage is a typed capability absence (module byte-truth)', async () => {
    const loaded = await loadOnDeviceModel({
      hasWebAssembly: true,
      digest: () => Promise.resolve('deadbee0'),
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('E_CAPABILITY');
      expect(loaded.error.details?.['what']).toBe('kernel-digest-mismatch');
    }
    // The committed stamp is provably the real digest:
    expect(FRAME_KERNEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(fromB64(FRAME_KERNEL_WASM_B64).length).toBeGreaterThan(100);
  });

  it('M4: capability negation ⇒ factory answers null; the deferred rung yields typed', async () => {
    const none = { hasWebAssembly: false };
    expect(await createOnDeviceNamer(none)).toBeNull();
    const deferred = createDeferredOnDeviceNamer(none);
    const ran = await deferred.run(namingInput(['react hooks guide']));
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.code).toBe('E_CAPABILITY');
      expect(ran.error.details?.['yield']).toBe(true);
      expect(ran.error.details?.['absent']).toBe(true);
    }
  });
});

describe('E8-T03 · naming + calibration law', () => {
  it('N1: sharp two-anchor evidence ⇒ dual-display calibrated name, deterministically', async () => {
    const namer = await createOnDeviceNamer(AMBIENT);
    if (namer === null) throw new Error('model unavailable');
    const ran = await namer.run(
      namingInput([
        'Merged pull request on github',
        'GitHub notifications center',
        'react hooks in depth guide',
        'React 19 features overview',
      ]),
    );
    if (!ran.ok) throw new Error(`run failed: ${ran.error.code}`);
    expect(ran.value.value).toBe('GitHub & React · 4 tabs');
    expect(ran.value.confidence).toBe(0.88); // sharp + dual stamp law
    expect(ran.value.provider).toBe(ONDEVICE_PROVIDER_ID);
    expect(ran.value.modelClass).toBe('ondevice-fwd-v1');
    expect(ran.value.schemaV).toBe(1);
    const again = await namer.run(
      namingInput([
        'Merged pull request on github',
        'GitHub notifications center',
        'react hooks in depth guide',
        'React 19 features overview',
      ]),
    );
    if (!again.ok) throw new Error('run failed');
    expect(again.value).toEqual(ran.value); // replay idempotence
  });

  it('N2: single-anchor evidence ⇒ single-display name with a mid stamp', async () => {
    const namer = await createOnDeviceNamer(AMBIENT);
    if (namer === null) throw new Error('model unavailable');
    const ran = await namer.run(namingInput(['retrospective about the docker rollout notes']));
    if (!ran.ok) throw new Error('run failed');
    expect(ran.value.value).toBe('deploy · 1 tabs');
    expect(ran.value.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('N3: thin evidence YIELDS (typed, never an artifact, never invented)', async () => {
    const namer = await createOnDeviceNamer(AMBIENT);
    if (namer === null) throw new Error('model unavailable');
    const ran = await namer.run(namingInput(['सपना देखना एक अच्छी बात है', 'random daily scroll']));
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.error.details?.['yield']).toBe(true);
      expect(ran.error.details?.['absent']).toBeUndefined();
    }
  });

  it('N4: artifacts from this provider pass the §2.12 boundary schema', async () => {
    const namer = await createOnDeviceNamer(AMBIENT);
    if (namer === null) throw new Error('model unavailable');
    const ran = await namer.run(
      namingInput(['github pull request review', 'sqlite query planner deep dive']),
    );
    if (!ran.ok) throw new Error('run failed');
    const verdict = validateArtifactCandidate(ran.value);
    expect(verdict.kind).toBe('valid');
  });

  it('N5: calibration floor is law — sub-floor posteriors assemble nothing', () => {
    expect(ONDEVICE_ACCEPT_POSTERIOR).toBe(0.6);
    expect(calibrate([], 5)).toBeNull();
  });
});

describe('E8-T03 · ladder integration law', () => {
  const jobRow = (input: unknown): AiJobRow => ({
    jobId: 'job-l1',
    kind: 'mission-name',
    subjectKey: 'k',
    payloadRef: { subjectId: 'mission-l1', input, stateHash: 'h' },
    lane: 'maintenance',
    state: 'claimed',
    attempts: 1,
    lease: { workerTag: 'w', expiresAt: WALL + 15_000 },
    createdAt: WALL,
    updatedAt: WALL,
    enqueuedAtSeq: 3,
  });

  it('L1: an absent on-device rung is NOT a breaker strike — heuristic answers in the same attempt', async () => {
    const deferred = createDeferredOnDeviceNamer({ hasWebAssembly: false });
    const ladder = createAiLadder({ providers: [deferred, createHeuristicNamer()] });
    const host = createSwLocalWorkerHost({ ladder });
    const outcome = await host.execute({
      now: WALL,
      deadlineMs: 30_000,
      job: jobRow({
        tabCount: 3,
        rootDomains: ['github.example'],
        takenAt: WALL,
        tabs: [{ title: 'vaguely nothing lexical', rootDomain: 'misc.example' }],
      }),
    });
    expect(outcome.kind).toBe('artifact');
    if (outcome.kind === 'artifact') expect(outcome.providerId).toBe('heuristic');
    const cell = ladder.breakerReports().find((b) => b.providerId === ONDEVICE_PROVIDER_ID);
    expect(cell?.consecutiveFailures).toBe(0);
    expect(cell?.state).toBe('closed');
  });
});
