// lint-fixture: src/surfaces/overlay/hostile-threshold.fixture.ts
// E8-T02 hostile fixture (R18): numeric confidence thresholding outside
// domain/memory MUST be caught — surfaces bind the Memory layer's pre-mapped
// presentation, never raw cutoffs. Also plants the raw-cutoff import variant.
// Evaluated only by scripts/isolation-lint.mjs's fixture law.
import { CONFIDENCE_TIER_HIGH_AT } from '@/domain/memory/index.js';

export const hostileRender = (confidence: number): string => {
  if (confidence >= 0.85) return 'asserted';
  return confidence >= CONFIDENCE_TIER_HIGH_AT ? 'asserted-too' : 'hidden';
};
