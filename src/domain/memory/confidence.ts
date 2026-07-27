// E8-T01 · domain/memory — the §6.11 confidence constitution. "Every AI artifact
// carries confidence ∈ {high, medium, low}; UI mapping: high = present normally ·
// medium = present with 'suggested' affordance · low = transform to neutral
// heuristic presentation. This scale is a product constant; no job may bypass it."
// Storage carries the numeric confidence (0..1, EES §5 memory_artifacts row); this
// module is the ONLY place the number becomes a presentation tier — surfaces never
// threshold numbers themselves (the Blueprint §2.2 row: domain/memory owns
// "map confidence→presentation tier (§6.11 constant)").

/** §6.11 tier vocabulary — a product constant, not a shape. */
export type ConfidenceTier = 'high' | 'medium' | 'low';

/** Rendering law per tier (§6.11): surfaces bind affordances to these, never to
 *  numeric cutoffs. 'neutral' = the honest heuristic frame (Spec §5.13 — never a
 *  guess wearing a lab coat). */
export type ConfidencePresentation = 'normal' | 'suggested' | 'neutral';

/** R7 CONTRACT CONSTANTS (EES risk register, frozen): HIGH ≥ 0.85 ·
 *  MED 0.60–0.85 · LOW < 0.60. Tunable via flag until Tier-3 freeze; any change
 *  after is a docs-visible event requiring an ADR note. The honest rung-1 label
 *  stamps 0.55 ⇒ LOW ⇒ the neutral heuristic frame — §5.13 law: shallow truth
 *  never borrows the suggestion affordance (E8-T02 adopted R7 verbatim). */
export const CONFIDENCE_TIER_HIGH_AT = 0.85;
export const CONFIDENCE_TIER_MEDIUM_AT = 0.6;

/** Inclusive numeric band check (boundary belongs to the HIGHER tier). */
export const confidenceTier = (confidence: number): ConfidenceTier => {
  if (!Number.isFinite(confidence)) return 'low';
  if (confidence >= CONFIDENCE_TIER_HIGH_AT) return 'high';
  if (confidence >= CONFIDENCE_TIER_MEDIUM_AT) return 'medium';
  return 'low';
};

/** §6.11 UI mapping, verbatim: high = present normally · medium = 'suggested'
 *  affordance · low = transform to neutral heuristic presentation. */
export const presentationForTier = (tier: ConfidenceTier): ConfidencePresentation => {
  switch (tier) {
    case 'high':
      return 'normal';
    case 'medium':
      return 'suggested';
    case 'low':
      return 'neutral';
  }
};

/** The one call surfaces make (number → affordance, one hop, no thresholds UI-side). */
export const confidencePresentation = (confidence: number): ConfidencePresentation =>
  presentationForTier(confidenceTier(confidence));
