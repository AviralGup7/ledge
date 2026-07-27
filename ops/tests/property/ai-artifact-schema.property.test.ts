// E8-T01 · property lane — the AI artifact boundary schema + confidence-tier law
// under arbitrary input. The gate the chaos suites cannot reach by enumeration:
// validators and mappings are TOTAL and LAWFUL over the whole input space —
//  * P1 TOTALITY: validateArtifactCandidate never throws, whatever the bytes.
//  * P2 SOUNDNESS: an accepted artifact always satisfies the §2.12 laws (full
//    boundary shape, confidence ∈ [0,1] finite, non-empty ids, schemaV ≥ 1).
//  * P3 CLASS MONOTONY: missing/ill-typed boundary fields classify
//    'malformed-shape'; well-shaped law-breaking content classifies
//    'invalid-value' — never swapped (the counters the probe reports).
//  * P4 TIER LAW: confidenceTier is monotone, boundary-inclusive upward, and
//    non-finite collapses to 'low' (§6.11 presentation safety).
//  * P5 §6.11 VERBATIM: high→normal · medium→suggested · low→neutral — the
//    mapping can never drift from the product constant.
//  * P6 COALESCING-KEY LAW: subjectKeyFor is deterministic and sensitive to each
//    leg (kind/subject/stateHash).
//  * P7 HONEST-LABEL TOTALITY: buildHeuristicMissionName never throws and always
//    renders the "N tabs" ledger form; the namer rung emits §2.12-valid
//    artifacts for ANY input bytes (never rejects by content).
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_TIER_HIGH_AT,
  CONFIDENCE_TIER_MEDIUM_AT,
  confidencePresentation,
  confidenceTier,
  presentationForTier,
  validateArtifactCandidate,
  type MemoryArtifactCandidate,
} from '@/domain/memory/index.js';
import { subjectKeyFor } from '@/infrastructure/ai/job-queue.js';
import {
  buildHeuristicMissionName,
  createHeuristicNamer,
  HEURISTIC_NAMER_CONFIDENCE,
  HEURISTIC_NAMER_MODEL_CLASS,
  type MissionNameInput,
} from '@/infrastructure/ai/providers/heuristic/namer.js';

/** Values that survived JSON (what IDB/wire can actually carry). */
const jsonValue = (): fc.Arbitrary<unknown> =>
  fc.anything({
    maxDepth: 3,
    withBigInt: false,
    withBoxedValues: false,
    withMap: false,
    withNullPrototype: false,
    withObjectString: false,
    withSet: false,
    withTypedArray: false,
    withSparseArray: false,
  });

const finiteConfidence = (): fc.Arbitrary<number> =>
  fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

const validCandidateArb = (): fc.Arbitrary<MemoryArtifactCandidate> =>
  fc.record({
    value: jsonValue().filter((v) => v !== undefined),
    confidence: finiteConfidence(),
    provider: fc.string({ minLength: 1 }),
    modelClass: fc.string({ minLength: 1 }),
    schemaV: fc.integer({ min: 1, max: 100 }),
  });

const missionNameInputArb = (): fc.Arbitrary<MissionNameInput> =>
  fc.record({
    tabCount: fc.nat({ max: 10_000 }),
    rootDomains: fc.array(fc.string({ maxLength: 64 }), { maxLength: 12 }),
    takenAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  });

describe('E8-T01 · artifact boundary schema (properties)', () => {
  it('P1: validation is total — arbitrary values never throw, always verdict', () => {
    fc.assert(
      fc.property(jsonValue(), (raw) => {
        const verdict = validateArtifactCandidate(raw);
        expect(verdict.kind === 'valid' || verdict.kind === 'rejected').toBe(true);
      }),
    );
  });

  it('P2: soundness — an accepted artifact always satisfies every §2.12 law', () => {
    fc.assert(
      fc.property(jsonValue(), (raw) => {
        const verdict = validateArtifactCandidate(raw);
        if (verdict.kind !== 'valid') return;
        const a = verdict.artifact;
        expect(a.value).not.toBeUndefined();
        expect(Number.isFinite(a.confidence)).toBe(true);
        expect(a.confidence).toBeGreaterThanOrEqual(0);
        expect(a.confidence).toBeLessThanOrEqual(1);
        expect(a.provider.length).toBeGreaterThan(0);
        expect(a.modelClass.length).toBeGreaterThan(0);
        expect(Number.isInteger(a.schemaV)).toBe(true);
        expect(a.schemaV).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  it('P2b: completeness — every lawful candidate validates with an echo artifact', () => {
    fc.assert(
      fc.property(validCandidateArb(), (candidate) => {
        const verdict = validateArtifactCandidate(candidate);
        expect(verdict.kind).toBe('valid');
        if (verdict.kind === 'valid') expect(verdict.artifact).toEqual(candidate);
      }),
    );
  });

  it('P3: class monotony — missing/ill-typed shape vs law-breaking content never swap', () => {
    const missingField = fc
      .record({
        confidence: finiteConfidence(),
        provider: fc.string({ minLength: 1 }),
        modelClass: fc.string({ minLength: 1 }),
        schemaV: fc.integer({ min: 1, max: 100 }),
      })
      .map((o) => ({ ...o, confidence: 'high' })); // shape-perfect, ill-typed leg
    fc.assert(
      fc.property(missingField, (raw) => {
        const verdict = validateArtifactCandidate(raw);
        expect(verdict.kind).toBe('rejected');
        if (verdict.kind === 'rejected') expect(verdict.rejectClass).toBe('malformed-shape');
      }),
    );
    const lawBreaking = fc.record({
      value: fc.string(),
      confidence: fc.oneof(
        fc.double({ min: 1.000_001, max: 1_000, noNaN: true }),
        fc.double({ min: -1_000, max: -0.000_001, noNaN: true }),
      ),
      provider: fc.string({ minLength: 1 }),
      modelClass: fc.string({ minLength: 1 }),
      schemaV: fc.integer({ min: 1, max: 100 }),
    });
    fc.assert(
      fc.property(lawBreaking, (raw) => {
        const verdict = validateArtifactCandidate(raw);
        expect(verdict.kind).toBe('rejected');
        if (verdict.kind === 'rejected') {
          expect(verdict.rejectClass).toBe('invalid-value');
          expect(verdict.what).toBe('confidence-out-of-range');
        }
      }),
    );
  });
});

describe('E8-T01 · §6.11 confidence-tier law (properties)', () => {
  const tierRank = (t: 'low' | 'medium' | 'high'): number =>
    t === 'low' ? 0 : t === 'medium' ? 1 : 2;

  it('P4: monotony — higher confidence never earns a lower tier', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        (a, b) => {
          if (a > b) return;
          expect(tierRank(confidenceTier(a)) <= tierRank(confidenceTier(b))).toBe(true);
        },
      ),
    );
  });

  it('P4b: boundaries belong to the HIGHER tier; non-finite collapses to low', () => {
    expect(confidenceTier(CONFIDENCE_TIER_HIGH_AT)).toBe('high');
    expect(confidenceTier(CONFIDENCE_TIER_MEDIUM_AT)).toBe('medium');
    expect(confidenceTier(CONFIDENCE_TIER_HIGH_AT - Number.EPSILON)).toBe('medium');
    expect(confidenceTier(CONFIDENCE_TIER_MEDIUM_AT - Number.EPSILON)).toBe('low');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(confidenceTier(bad)).toBe('low');
    }
  });

  it('P5: the §6.11 mapping is verbatim — high→normal · medium→suggested · low→neutral', () => {
    expect(presentationForTier('high')).toBe('normal');
    expect(presentationForTier('medium')).toBe('suggested');
    expect(presentationForTier('low')).toBe('neutral');
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (c) => {
        const p = confidencePresentation(c);
        expect(p === 'normal' || p === 'suggested' || p === 'neutral').toBe(true);
        // The R7 anchor: rung-1's honest 0.55 stamps LOW ⇒ the neutral frame —
        // shallow truth never borrows the suggestion affordance (§5.13).
        expect(confidencePresentation(HEURISTIC_NAMER_CONFIDENCE)).toBe('neutral');
      }),
    );
  });
});

describe('E8-T01 · subject-key + honest-label law (properties)', () => {
  it('P6: subjectKeyFor is deterministic and leg-sensitive', () => {
    const legs = fc.record({
      kind: fc.constant('mission-name' as const),
      subjectId: fc.string({ maxLength: 40 }),
      stateHash: fc.string({ maxLength: 40 }),
    });
    fc.assert(
      fc.property(legs, legs, (a, b) => {
        const ka = subjectKeyFor(a.kind, a.subjectId, a.stateHash);
        expect(ka).toBe(subjectKeyFor(a.kind, a.subjectId, a.stateHash));
        const same =
          a.kind === b.kind && a.subjectId === b.subjectId && a.stateHash === b.stateHash;
        const kb = subjectKeyFor(b.kind, b.subjectId, b.stateHash);
        if (same) expect(ka).toBe(kb);
        if (!same) expect(ka).not.toBe(kb);
      }),
    );
  });

  it('P7: the honest label is total and ledger-shaped for arbitrary inputs', () => {
    fc.assert(
      fc.property(missionNameInputArb(), (input) => {
        const label = buildHeuristicMissionName(input);
        expect(label.startsWith(`${input.tabCount} `)).toBe(true);
        expect(label).toContain(input.tabCount === 1 ? '1 tab ·' : 'tabs ·');
        expect(label.length).toBeGreaterThan(0);
        // Deterministic — redelivery idempotence (chaos law).
        expect(buildHeuristicMissionName(input)).toBe(label);
      }),
    );
  });

  it('P7b: the rung-1 provider emits §2.12-valid artifacts for ANY input bytes', async () => {
    const namer = createHeuristicNamer();
    await fc.assert(
      fc.asyncProperty(jsonValue(), async (rawInput) => {
        const ran = await namer.run({ kind: 'mission-name', subjectId: 's', value: rawInput });
        expect(ran.ok).toBe(true);
        if (!ran.ok) return;
        expect(ran.value.confidence).toBe(HEURISTIC_NAMER_CONFIDENCE);
        expect(ran.value.modelClass).toBe(HEURISTIC_NAMER_MODEL_CLASS);
        const verdict = validateArtifactCandidate(ran.value);
        expect(verdict.kind).toBe('valid');
      }),
    );
  });
});
