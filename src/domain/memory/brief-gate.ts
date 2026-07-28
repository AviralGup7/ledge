// E8-T05 · domain/memory — the resumption-brief gate (Spec §6.9 + §6.11,
// EES-R18). Pure, total, and the ONLY place a dismissed stamp or a LOW tier
// becomes "no card". Laws this module keeps:
//  * DISMISSAL OUTRANKS EVIDENCE: a dismissed brief never returns, even if a
//    newer artifact lands (the dismissal is the user's per-mission-forever
//    preference — W5), recorded truth, not a deletion (ADR-041-adjacent: the
//    artifact stays in memory for other surfaces).
//  * LOW ⇒ ABSENT (§6.11 made concrete for briefs): "transform to neutral
//    heuristic presentation" FOR A BRIEF IS ABSENCE — briefs have no neutral
//    counts form by design, so a low-confidence brief prefers absence to a
//    frame it cannot honestly wear.
//  * R18: tiers come from confidencePresentation (the §6.11 constants own the
//    numbers); this module never thresholds a raw confidence itself.
//  * ABSENT ≠ DISMISSED: surfaces render nothing for both, but the vocabulary
//    stays distinct so probes/tests can tell preference from lawful silence.
import { confidencePresentation, type ConfidencePresentation } from './confidence.js';

/** The artifact slice the gate reads (the journal event's payload shape —
 *  already validated at the boundary; the gate stays total over violations). */
export interface BriefGateArtifact {
  readonly value: unknown;
  readonly confidence: number;
}

export type BriefGateDecision =
  | {
      readonly kind: 'show';
      readonly text: string;
      readonly presentation: ConfidencePresentation;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'dismissed' };

/**
 * Decide ONE mission's brief rendering. Order of law: dismissal → absence of
 * artifact → shape totality → tier. 'suggested' is the medium-tier affordance
 * (§6.11), passed through untouched — the surface binds the affordance to the
 * presentation word, never to a number.
 */
export const briefsGate = (args: {
  readonly artifact?: BriefGateArtifact | undefined;
  readonly dismissed: boolean;
}): BriefGateDecision => {
  if (args.dismissed) return { kind: 'dismissed' };
  const artifact = args.artifact;
  if (artifact === undefined) return { kind: 'absent' };
  if (typeof artifact.value !== 'string' || artifact.value.length === 0) {
    return { kind: 'absent' };
  }
  const presentation = confidencePresentation(artifact.confidence);
  // §6.11 low-tier law: the neutral transform for a brief is absence itself.
  if (presentation === 'neutral') return { kind: 'absent' };
  return { kind: 'show', text: artifact.value, presentation };
};
