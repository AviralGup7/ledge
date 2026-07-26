// E6-T01 · Recovery boot port seam (A-05/dependency law: application never imports
// infrastructure). The boot reconciler/report types live in infrastructure/recovery
// (E2-T06/T07); application consumes a STRUCTURAL SUBSET — exactly the fields the
// W7 service reads (`HeartbeatReadModel` at the outbox is the precedent: boundary
// shapes are re-declared, never imported across the law line). TypeScript's
// structural assignability seals the drift: the composition root passes the full
// infrastructure BootReport wherever this input is declared, so an infrastructure
// rename of a consumed field fails typecheck AT the root.

/** The one intent-resolution fact disclosure assembly consumes. */
export interface BootResolutionInput {
  readonly disposition: string;
}

/** The boot-signal facts the §14.4/R16 announce + copy path consume. */
export interface BootSignalInput {
  /** true ⟺ cause ∈ {updated, crashed} — abnormal termination detected. */
  readonly abnormal: boolean;
  readonly cause: string;
  /** §14.4-gated copy key, computed at the report's single evaluation site. */
  readonly copyKey: string | null;
  readonly gaps: readonly string[];
}

/**
 * The BootReport facts the W7 service consumes (EES §2.13 report schema v1 —
 * subset view; the incident slot persists whatever object the root deposits,
 * but the service's decisions depend on nothing beyond this shape).
 */
export interface BootReportInput {
  readonly outcome: string;
  /** §14.4 gating input, computed by the reconciler (card shown only when true). */
  readonly lossRisk: boolean;
  readonly crossCheck: string;
  readonly bootTs: number;
  readonly bootSignal: BootSignalInput;
  readonly resolutions: readonly BootResolutionInput[];
  readonly gaps: readonly string[];
}
