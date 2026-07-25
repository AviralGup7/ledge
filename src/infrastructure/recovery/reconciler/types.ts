// E2-T06 · boot reconciler types — ADR-011 dangling-intent resolution, EES §2.13
// conservative law, EES §10-R2 command→observation race law, Blueprint §5 recovery
// component ("runBootSequence() → BootReport (clean | recovered | reconciled(scope))").
//
// The reconciler is the ONLY component allowed to converge a torn intent: executors
// own the happy path, the journal owns the truth, this module owns the morning
// after. Its one law above all others (ADR-011, Spec failure law): when completion
// is unprovable, choose the branch that cannot destroy user content — leave open
// and disclose. It never "finishes" a close it cannot re-prove from the journal,
// and it never acts en masse without per-intent proof.
import type { Id, DeviceId, IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { IntentLedgerPort } from '@/application/ports/intent-ledger.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';

/** BootReport schema covenant (EES §2.13 versioning law). */
export const RECONCILE_REPORT_SCHEMA_V = 1;

/** §10-R2 dedupe key family: (intentId, browserTabId) — evidence counted once. */
export interface EvidenceKey {
  readonly intentId: string;
  readonly browserTabId: number;
}

/**
 * Blueprint §5 outcome triple. BootReport is ALWAYS produced — even 'clean'.
 *  - clean:      journal healthy, nothing pending, nothing to disclose.
 *  - reconciled: ≥1 intent resolved (any disposition) — precise scope attached.
 *  - recovered:  the boot itself was degraded (integrity probe/pending scan failed,
 *                crash marker stale) — resolutions were NOT attempted en masse.
 */
export type BootOutcome = 'clean' | 'recovered' | 'reconciled';

/**
 * Per-intent stale classification (§2.13 command→observation mapping):
 *  - stable-lag:        terminal truth durable; only the ledger row lagged.
 *  - externally-closed: user/browser closed intent-covered tabs mid-flight (R2).
 *  - lost-in-crash:     no completion proof anywhere — the crash took the answer.
 */
export type StaleClass = 'stable-lag' | 'externally-closed' | 'lost-in-crash';

/** What the reconciler DID about one dangling intent. */
export type IntentDisposition =
  /** Terminal event already durable — row converged to it, byte-exact re-drive. */
  | 'completed-safe'
  /** §10-R2: full external-close coverage of the intent's tabs — completion stamped
   *  from evidence, every (intentId, browserTabId) secured exactly once. */
  | 'completed-evidence'
  /** Unprovable / partial proof — conservative abort, leave-open + disclose. */
  | 'aborted-conservative'
  /** Nothing provable AND no lawful abort row exists (non-park families, or the
   *  journal refused a write) — left pending, retry-counted, disclosed. */
  | 'deferred';

export interface IntentResolution {
  readonly intentId: Id;
  readonly cid: Id;
  readonly kind: string;
  readonly stale: StaleClass;
  readonly disposition: IntentDisposition;
  /** Human/ops reason token (no free text — stable tokens for the W7 card). */
  readonly reason: string;
  /** R2 evidence: browserTabIds of this intent proven closed (≤ once each). */
  readonly evidenceTabs: readonly number[];
  /** TabsParked.secured when disposition=completed-evidence (dedupe law). */
  readonly securedCounted: number;
  /** ParkAborted.liveLeftOpen when disposition=aborted-conservative. */
  readonly liveLeftOpen: number;
  /** Latent write/probe failure code when the journal/ledger refused (else absent). */
  readonly errorCode?: string | undefined;
}

export interface JournalProbeReport {
  readonly ok: boolean;
  readonly durableThrough: number;
  readonly errorCode?: string | undefined;
}

export interface ProjectionsBootReport {
  readonly applied: number;
  readonly watermarkFrom: number;
  readonly watermarkTo: number;
  readonly errorCode?: string | undefined;
}

export interface BootReport {
  readonly schemaV: typeof RECONCILE_REPORT_SCHEMA_V;
  readonly deviceId: DeviceId;
  readonly bootTs: number;
  readonly outcome: BootOutcome;
  /** §14.4 gating input: recovery card shown ONLY when true. */
  readonly lossRisk: boolean;
  readonly journalProbe: JournalProbeReport;
  readonly intentsExamined: number;
  readonly resolutions: readonly IntentResolution[];
  readonly evidence: {
    /** Total external closes judged as intent-completion evidence (once each). */
    readonly coveredOnce: number;
    /** Closes referencing intent scopes already secured — never double-counted. */
    readonly doubleCountPrevented: number;
  };
  readonly projections: ProjectionsBootReport | null;
  /** sessions cross-check (EES §2.13 failure law: degrade with logged gap). */
  readonly crossCheck: 'applied' | 'degraded-unavailable';
  /** Forward-tolerance + remediation notes (preserved unknowns, probe gaps…). */
  readonly gaps: readonly string[];
}

/**
 * Optional seams. crossCheck: chrome.sessions candidate assembly lands with the
 * sessions adapter (E3); until wired, boots report 'degraded-unavailable' (the
 * EES §2.13 sanctioned degrade). liveTabsProbe: roots bind tabs.query when the
 * adapters are live — ParkAborted.liveLeftOpen is a PROVEN live count when the
 * probe is present, and best-known (scope-remainder) with a logged gap otherwise.
 */
export interface ReconcilerDeps {
  readonly journal: JournalPort;
  readonly ledger: IntentLedgerPort;
  readonly projections?: ProjectionEnginePort | undefined;
  readonly crossCheck?: (() => Promise<Result<readonly string[], LedgeError>>) | undefined;
  readonly liveTabsProbe?: (() => Promise<Result<number, LedgeError>>) | undefined;
  readonly deviceId: DeviceId;
  readonly now: Now;
  readonly ids: IdGenerator;
}
