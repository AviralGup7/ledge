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

/** Tier cutoffs on the stored 0..1 confidence. Chosen policy (E8-T01 ADR note):
 *  the medium band is intentionally wide — heuristic rung-1 artifacts (0.55)
 *  surface as suggestions, which is §6.1's rename affordance; truly hollow output
 *  (< 0.5) collapses to the neutral heuristic frame instead of being presented
 *  as a guess. tighten-only per ADR law. */
export const CONFIDENCE_TIER_HIGH_AT = 0.8;
export const CONFIDENCE_TIER_MEDIUM_AT = 0.5;

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
