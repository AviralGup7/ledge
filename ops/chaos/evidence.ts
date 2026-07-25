// E2-T09 · G1 chaos evidence (roadmap §3 M1-exit: "chaos 0-loss… nothing
// user-facing without G1"; EES §8 release gates: "chaos 0-loss"). The driver
// sweeps every kill point + every corrupted-journal seed and folds the
// outcomes into THIS report — a deterministic, clock-free, reproducible
// artifact committed at ops/chaos/evidence/g1-chaos-evidence.v1.json.
//
// Reproducibility law: byte-identical across runs and machines ⟺ the gates'
// claims are reproducible. Hence: no wall clocks, no volatile ids (decision
// projections only), digest = sha256 over the canonical JSON (stableStringify) of the body plus
// the digest of the NORMATIVE points.txt — an edit to the point list re-ids
// the evidence. A golden mismatch fails the harness suite; refreshing the
// golden is a deliberate, review-visible act (pnpm test:chaos:evidence).
import { createHash } from 'node:crypto';
import { stableStringify } from '@/shared-kernel/canon/index.js';

export interface ReconcilerPointOutcome {
  readonly owner: 'reconciler';
  readonly point: string;
  /** Resolution disposition, or 'none' when the kill left nothing durable. */
  readonly disposition: string;
  /** BootReport outcome triple (clean/reconciled/…). */
  readonly outcome: string;
  readonly lossRisk: boolean;
  readonly intentsExamined: number;
  readonly securedCounted: number;
  readonly liveLeftOpen: number;
  readonly evidenceTabs: readonly number[];
  /** Journal events the reconcile itself appended (resolution writes only). */
  readonly eventsWrittenByReconcile: number;
}

export interface MarkerPointOutcome {
  readonly owner: 'marker';
  readonly point: string;
  /** Classification the next boot must reach after the torn wake. */
  readonly cause: string;
  /** Catalog copy key the classification maps to (null = no card). */
  readonly copyKey: string | null;
  /** The FOLLOW-ON boot's cause (self-heal / R16 no-double law). */
  readonly followUpCause: string;
}

export interface CompactPointOutcome {
  readonly owner: 'compact';
  readonly point: string;
  /** scanFull was clean over the torn image (running/done baseline law L6). */
  readonly tornScanOk: boolean;
  /** compact() over the torn image resumed a running baseline. */
  readonly resumed: boolean;
  /** ...or replayed a done baseline as a byte-true no-op that restamps. */
  readonly noOp: boolean;
  /** Epoch totals after convergence (carried + fresh exclusions). */
  readonly entriesExcluded: number;
  /** L7: durable truth (events+meta) byte-identical to the uninterrupted twin. */
  readonly byteEqualToTwin: boolean;
}

export type KillPointOutcome = ReconcilerPointOutcome | MarkerPointOutcome | CompactPointOutcome;

export interface CorruptedSeedOutcome {
  readonly seed: string;
  /** Damage class (rot-sealed / rot-open-tail / crc-flip / checkpointed-rot / head-drift). */
  readonly damageClass: string;
  /** Scanner always catches the seeded damage (suspects non-empty, reasons as expected). */
  readonly detected: boolean;
  /** Suspect reasons found by scanFull, sorted. */
  readonly suspects: readonly string[];
  /** BootReport outcome under unreadable truth ('recovered' = degraded boot named). */
  readonly bootOutcome: string;
  /** reconcileBoot's degraded marker under unreadable truth (null would be a lie). */
  readonly degraded: string | null;
  /** Conservative law: zero resolutions were issued against corrupt bytes. */
  readonly resolutionsIssued: number;
  /**
   * Prefix honesty: the seqs below the damage were served byte-identical after
   * the damage (true), or there was no healthy prefix to serve ('none'), or a
   * range overlapping the damage was served (false — that would break the law).
   */
  readonly prefixHonest: boolean | 'none';
  /** A range that OVERLAPS the damage must be refused (E_JOURNAL_INTEGRITY). */
  readonly overlapRefused: boolean;
  /** Zero writes: journal segments + heads were byte-frozen across the reconcile. */
  readonly journalFrozen: boolean;
}

export interface ChaosEvidenceBodyV1 {
  readonly schemaV: 1;
  readonly gate: 'G1';
  readonly suite: 'E2-T09';
  readonly pointsCount: number;
  readonly pointsFileDigest: string;
  readonly killPoints: readonly KillPointOutcome[];
  readonly corruptedSeeds: readonly CorruptedSeedOutcome[];
}

export interface ChaosEvidenceReportV1 extends ChaosEvidenceBodyV1 {
  /** sha256 over canonicalize(body) — the reproducibility fingerprint. */
  readonly reportDigest: string;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const digestKillPointsFile = (normative: string): string => sha256Hex(normative);

export const buildEvidence = (body: ChaosEvidenceBodyV1): ChaosEvidenceReportV1 => ({
  ...body,
  reportDigest: sha256Hex(stableStringify(body)),
});

/** Golden-artifact indent (2-space — must match prettier's JSON style exactly:
 *  lint:format checks the committed golden, this string IS the golden). */
const GOLDEN_INDENT = 2;

/** Stable text form for the golden artifact + comparisons (canonical JSON,
 *  pretty-printed with a trailing newline for diff-friendliness). */
export const serializeEvidence = (report: ChaosEvidenceReportV1): string =>
  `${JSON.stringify(JSON.parse(stableStringify(report)) as unknown, null, GOLDEN_INDENT)}\n`;
