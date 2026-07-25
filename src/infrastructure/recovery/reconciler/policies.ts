// E2-T06 · intent-kind reconciliation policies (Blueprint §5 "uncertain ⇒ conservative
// branch; never mass-act without proof").
//
// Executors don't all exist yet (park/resume land E3+). The reconciler therefore
// routes every dangling intent through an explicit FAMILY policy instead of trusting
// kind strings ad hoc: each family declares its §4-catalog terminal rows (complete /
// abort), whether §10-R2 close-evidence can complete it, and how to extract the
// browser-tab refs R2 dedupes on. Kinds no policy recognizes take the universal
// conservative branch: defer + disclose — never abort what we cannot name.
import type { Id } from '@/shared-kernel/identity/index.js';
import type { EventTypeName } from '@/shared-kernel/events/index.js';
import type { IngestDraft } from '@/application/hub/ingest/index.js';

/** Executor families the catalog (§4) can speak for. */
export type IntentFamily = 'park-close' | 'resume-create' | 'delete-close' | 'universal';

export interface FamilyPolicy {
  readonly family: IntentFamily;
  /** Catalog rows that prove terminal completion for this family. */
  readonly completeTypes: readonly EventTypeName[];
  /** Catalog rows that prove terminal abortion for this family. */
  readonly abortTypes: readonly EventTypeName[];
  /**
   * §10-R2 applicability: TRUE only when an external close of an in-scope tab is
   * lawful completion evidence (close-class operations the user can race). Resume/
   * create operations never treat a close as completion — a created tab closing
   * means the user acted, not that Ledge finished.
   */
  readonly r2Completes: boolean;
  /**
   * TRUE only when a lawful abort row exists in §4 for this family. Families
   * without one defer instead of improvising events (the catalog is law).
   */
  readonly hasAbortRow: boolean;
}

const PARK_POLICY: FamilyPolicy = {
  family: 'park-close',
  completeTypes: ['TabsParked'],
  abortTypes: ['ParkAborted'],
  r2Completes: true,
  hasAbortRow: true,
};

const RESUME_POLICY: FamilyPolicy = {
  family: 'resume-create',
  completeTypes: ['MissionResumed'],
  abortTypes: [],
  r2Completes: false,
  hasAbortRow: false,
};

const DELETE_POLICY: FamilyPolicy = {
  family: 'delete-close',
  completeTypes: ['EntityTrashed', 'MissionArchived'],
  abortTypes: [],
  // Delete races the user closing tabs daily — the close IS the user's intent;
  // evidence may prove completion, never justify abort-by-proxy.
  r2Completes: true,
  hasAbortRow: false,
};

const UNIVERSAL_POLICY: FamilyPolicy = {
  family: 'universal',
  completeTypes: [],
  abortTypes: [],
  r2Completes: false,
  hasAbortRow: false,
};

/** Wire-command (IntentRecord.kind) → family. Unknown kinds are universal.
 *  Names are the §3.3 contract command names (message registry is law). */
const KIND_FAMILY: Readonly<Record<string, IntentFamily>> = {
  ParkTab: 'park-close',
  ParkGroup: 'park-close',
  ParkWindow: 'park-close',
  ParkAll: 'park-close',
  ResumeMission: 'resume-create',
  RestoreRecentlyClosed: 'resume-create',
  DeleteEntity: 'delete-close',
  EmptyTrash: 'delete-close',
  // Undo/ArchiveMission/ConcludeMission/ImportCommit: deliberately unmapped —
  // their executors land with their own epics (E4/E7) and own the ADR-reviewed
  // evidence mapping; until then the universal policy defers them, never guesses.
};

export const FAMILY_POLICIES: Readonly<Record<IntentFamily, FamilyPolicy>> = {
  'park-close': PARK_POLICY,
  'resume-create': RESUME_POLICY,
  'delete-close': DELETE_POLICY,
  universal: UNIVERSAL_POLICY,
};

export const policyFor = (kind: string): FamilyPolicy => {
  const family = KIND_FAMILY[kind];
  return FAMILY_POLICIES[family ?? 'universal'];
};

/**
 * Best-effort browser-tab refs for R2, by tolerant shape-reading of the intent
 * scope (executors define their own scope; the reconciler must never crash on a
 * shape it doesn't know — null means "R2 inapplicable", never an error).
 * Recognized: {browserTabId:n} · {tabIds:[n…]} · {tabs:[{browserTabId:n}…]} ·
 * {browserTabIds:[n…]} (deduped, order-stable).
 */
export const scopeTabRefs = (scope: unknown): readonly number[] | null => {
  if (typeof scope !== 'object' || scope === null) return null;
  const rec = scope as Record<string, unknown>;
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (v: unknown): void => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  if (typeof rec['browserTabId'] === 'number') push(rec['browserTabId']);
  const fromArray = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    for (const item of v) {
      if (typeof item === 'number') push(item);
      else if (typeof item === 'object' && item !== null) {
        push((item as Record<string, unknown>)['browserTabId']);
      }
    }
  };
  fromArray(rec['tabIds']);
  fromArray(rec['browserTabIds']);
  fromArray(rec['tabs']);
  return out.length === 0 ? null : out;
};

/** §10-R2 completion event (park family): secured counted exactly once per ref. */
export const buildEvidenceCompletion = (intentId: Id, secured: number): IngestDraft => ({
  type: 'TabsParked',
  payload: { intentId, secured },
});

/** Conservative abort row (park family) — leave-open + disclose, Spec law. */
export const buildConservativeAbort = (intentId: Id, liveLeftOpen: number): IngestDraft => ({
  type: 'ParkAborted',
  payload: { intentId, reason: 'boot-reconcile:completion-unprovable', liveLeftOpen },
});

/** Disposition reasons (stable tokens — W7 card copy keys, never sentences). */
export const REASON = {
  terminalDurable: 'terminal-event-durable',
  evidenceComplete: 'external-close-evidence-complete',
  evidencePartial: 'external-close-evidence-partial',
  noEvidence: 'completion-unprovable',
  noAbortRow: 'defer:no-abort-row',
  writeFailed: 'defer:resolution-write-failed',
  unknownKind: 'defer:unmanaged-kind',
  noAcceptanceTrail: 'defer:acceptance-trail-missing',
} as const;
