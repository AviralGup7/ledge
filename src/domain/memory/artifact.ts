// E8-T01 · domain/memory — the artifact boundary law (EES §2.12 constitutional
// invariant): "artifact requires {value, confidence, provider, modelClass} —
// missing ⇒ rejected pre-write · artifact schemaV stamped". Validation is a PURE,
// TOTAL function of the candidate shape — the AI package (and any future provider)
// physically cannot ship an artifact that failed here; the application commit path
// calls this before every journal write (ADR-041's boundary schema enforcement).

/** The validated artifact, ready to become one MemoryArtifactWritten event
 *  (§5 memory_artifacts row fields; derivedFromSeqRange/artifactId/jobId are
 *  stamped by the application commit, not by the producer). */
export interface MemoryArtifactCandidate {
  readonly value: unknown;
  readonly confidence: number;
  readonly provider: string;
  readonly modelClass: string;
  readonly schemaV: number;
}

/** Rejection classes — counted by the pipeline (EES §2.12 "malformed ⇒ reject +
 *  count"): 'malformed-shape' = boundary fields missing/ill-typed (never trust the
 *  producer); 'invalid-value' = well-shaped but law-breaking content (confidence
 *  out of range, empty string provider, non-positive schemaV, absent value). */
export type ArtifactRejectClass = 'malformed-shape' | 'invalid-value';

export type ArtifactValidation =
  | { readonly kind: 'valid'; readonly artifact: MemoryArtifactCandidate }
  | { readonly kind: 'rejected'; readonly rejectClass: ArtifactRejectClass; readonly what: string };

const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;
const SCHEMA_V_MIN = 1;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Total boundary validation. `undefined` value is rejected (an artifact claiming
 * nothing is not an artifact); every other JSON-cloneable value passes the shape
 * gate — semantic emptiness (e.g. an empty name) is the producer's confidence
 * problem, answered by §6.11's low-tier law, not by this gate.
 */
export const validateArtifactCandidate = (candidate: unknown): ArtifactValidation => {
  if (typeof candidate !== 'object' || candidate === null) {
    return { kind: 'rejected', rejectClass: 'malformed-shape', what: 'not-an-object' };
  }
  const raw = candidate as Readonly<Record<string, unknown>>;
  if (!('value' in raw) || raw['value'] === undefined) {
    return { kind: 'rejected', rejectClass: 'malformed-shape', what: 'value-missing' };
  }
  if (typeof raw['confidence'] !== 'number') {
    return { kind: 'rejected', rejectClass: 'malformed-shape', what: 'confidence-missing' };
  }
  if (typeof raw['provider'] !== 'string') {
    return { kind: 'rejected', rejectClass: 'malformed-shape', what: 'provider-missing' };
  }
  if (typeof raw['modelClass'] !== 'string') {
    return { kind: 'rejected', rejectClass: 'malformed-shape', what: 'modelClass-missing' };
  }
  if (typeof raw['schemaV'] !== 'number') {
    return { kind: 'rejected', rejectClass: 'malformed-shape', what: 'schemaV-missing' };
  }
  if (!Number.isFinite(raw['confidence'])) {
    return { kind: 'rejected', rejectClass: 'invalid-value', what: 'confidence-nonfinite' };
  }
  if (raw['confidence'] < CONFIDENCE_MIN || raw['confidence'] > CONFIDENCE_MAX) {
    return { kind: 'rejected', rejectClass: 'invalid-value', what: 'confidence-out-of-range' };
  }
  if (!isNonEmptyString(raw['provider'])) {
    return { kind: 'rejected', rejectClass: 'invalid-value', what: 'provider-empty' };
  }
  if (!isNonEmptyString(raw['modelClass'])) {
    return { kind: 'rejected', rejectClass: 'invalid-value', what: 'modelClass-empty' };
  }
  if (!Number.isInteger(raw['schemaV']) || raw['schemaV'] < SCHEMA_V_MIN) {
    return { kind: 'rejected', rejectClass: 'invalid-value', what: 'schemaV-below-one' };
  }
  return {
    kind: 'valid',
    artifact: {
      value: raw['value'],
      confidence: raw['confidence'],
      provider: raw['provider'],
      modelClass: raw['modelClass'],
      schemaV: raw['schemaV'],
    },
  };
};
