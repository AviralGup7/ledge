// E8-T01 · domain/memory unit laws — §6.11 tier mapping is a product constant
// (boundaries belong to the HIGHER tier), and the §2.12 artifact boundary is
// total over hostile producer output (missing ⇒ rejected pre-write, counted).
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_TIER_HIGH_AT,
  CONFIDENCE_TIER_MEDIUM_AT,
  confidencePresentation,
  confidenceTier,
  presentationForTier,
} from './confidence.js';
import { validateArtifactCandidate } from './artifact.js';

describe('§6.11 confidence tier law', () => {
  it('maps numeric confidence to tiers with higher-tier boundary ownership', () => {
    expect(confidenceTier(1)).toBe('high');
    expect(confidenceTier(CONFIDENCE_TIER_HIGH_AT)).toBe('high');
    expect(confidenceTier(CONFIDENCE_TIER_HIGH_AT - 0.01)).toBe('medium');
    expect(confidenceTier(CONFIDENCE_TIER_MEDIUM_AT)).toBe('medium');
    expect(confidenceTier(CONFIDENCE_TIER_MEDIUM_AT - 0.01)).toBe('low');
    expect(confidenceTier(0)).toBe('low');
  });

  it('heuristic rung-1 confidence (0.55) surfaces as a suggestion (§6.1 affordance)', () => {
    expect(confidenceTier(0.55)).toBe('medium');
    expect(confidencePresentation(0.55)).toBe('suggested');
  });

  it('non-finite confidence is the low tier (never a NaN guess)', () => {
    expect(confidenceTier(Number.NaN)).toBe('low');
    expect(confidenceTier(Number.POSITIVE_INFINITY)).toBe('low');
  });

  it('§6.11 UI mapping verbatim: normal · suggested · neutral', () => {
    expect(presentationForTier('high')).toBe('normal');
    expect(presentationForTier('medium')).toBe('suggested');
    expect(presentationForTier('low')).toBe('neutral');
  });

  it('tier is monotonic in confidence (no suggestive-below-neutral inversions)', () => {
    const order = { low: 0, medium: 1, high: 2 } as const;
    for (let c = 0; c < 1; c += 0.01) {
      expect(order[confidenceTier(c + 0.01)]).toBeGreaterThanOrEqual(order[confidenceTier(c)]);
    }
  });
});

describe('§2.12 artifact boundary law', () => {
  const valid = {
    value: '12 tabs · docs · 4:32 pm',
    confidence: 0.55,
    provider: 'heuristic',
    modelClass: 'heuristic-domain-time-v1',
    schemaV: 1,
  };

  it('accepts a well-formed candidate verbatim', () => {
    const r = validateArtifactCandidate(valid);
    expect(r.kind).toBe('valid');
    if (r.kind === 'valid') expect(r.artifact).toEqual(valid);
  });

  it('rejects missing mandatory fields as malformed-shape (pre-write law)', () => {
    for (const field of ['value', 'confidence', 'provider', 'modelClass', 'schemaV'] as const) {
      const broken = Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== field),
      ) as Record<string, unknown>;
      const r = validateArtifactCandidate(broken);
      expect(r.kind).toBe('rejected');
      if (r.kind === 'rejected') expect(r.rejectClass).toBe('malformed-shape');
    }
  });

  it('rejects non-objects and undefined values as malformed-shape', () => {
    expect(validateArtifactCandidate(undefined).kind).toBe('rejected');
    expect(validateArtifactCandidate('name').kind).toBe('rejected');
    const undefinedValue = validateArtifactCandidate({ ...valid, value: undefined });
    expect(undefinedValue.kind).toBe('rejected');
    if (undefinedValue.kind === 'rejected')
      expect(undefinedValue.rejectClass).toBe('malformed-shape');
  });

  it('rejects law-breaking values as invalid-value (shape ok, content broken)', () => {
    const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
      [{ ...valid, confidence: -0.1 }, 'confidence-out-of-range'],
      [{ ...valid, confidence: 1.1 }, 'confidence-out-of-range'],
      [{ ...valid, confidence: Number.NaN }, 'confidence-nonfinite'],
      [{ ...valid, provider: '' }, 'provider-empty'],
      [{ ...valid, modelClass: '' }, 'modelClass-empty'],
      [{ ...valid, schemaV: 0 }, 'schemaV-below-one'],
      [{ ...valid, schemaV: 1.5 }, 'schemaV-below-one'],
    ];
    for (const [candidate, what] of cases) {
      const r = validateArtifactCandidate(candidate);
      expect(r.kind).toBe('rejected');
      if (r.kind === 'rejected') {
        expect(r.rejectClass).toBe('invalid-value');
        expect(r.what).toBe(what);
      }
    }
  });

  it('structured-cloneable values of any JSON shape pass the shape gate', () => {
    const exotic = validateArtifactCandidate({ ...valid, value: { nested: [1, 'a'] } });
    expect(exotic.kind).toBe('valid');
    const falsy = validateArtifactCandidate({ ...valid, value: 0 });
    expect(falsy.kind).toBe('valid');
  });
});
