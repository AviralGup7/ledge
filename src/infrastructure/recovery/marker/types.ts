// E2-T07 · crash-marker types — ADR-007 §4 detection without a shutdown hook,
// EES-R16 update-vs-crash disambiguation, Blueprint §6.2/§6.7 boot-path law.
//
// Marker vocabulary (three records, two storage areas — schemaV'd, forward-
// tolerant on read: unknown fields tolerated, wrong shape ⇒ treated ABSENT with
// a 'marker-unreadable:<key>' gap, never a crash of the classifier itself):
//
//   SESSION 'ledge.boot.alive'   — armed on EVERY SW wake. Session storage
//      survives SW recycling but not browser restart (ADR-007 §4): its presence
//      proves the browser session never died; its absence after relaunch is the
//      browser-termination signal. Content is near-free (presence is the signal).
//   LOCAL 'ledge.marker.install' — stamped ONLY by the onInstalled listener
//      (install|update|chrome_update|shared_module_update). R16's disambiguator:
//      a stamp change since the last completed boot means an update intervened,
//      which is the classic way a browser restart is NOT a crash.
//   LOCAL 'ledge.marker.boot'    — stamped by the boot lifecycle AFTER
//      classification+arming complete (freshness = last time the SW was known
//      alive, version = last build we RAN). Absent-with-install-stamp means the
//      first boot never completed (collapses to first-run — W1 re-entry is
//      idempotent; never fabricate a crash from it).
//
// The classifier is PURE (classify.ts); storage I/O lives in lifecycle.ts.

/** Marker record schema covenant. v1 is the first; unknown future fields tolerated. */
export const MARKER_SCHEMA_V = 1;

export const MARKER_KEYS = {
  alive: 'ledge.boot.alive',
  install: 'ledge.marker.install',
  boot: 'ledge.marker.boot',
} as const;

/** chrome.runtime.onInstalled reason vocabulary (MV3 contract). */
export type InstallReason = 'install' | 'update' | 'chrome_update' | 'shared_module_update';

export interface AliveMarker {
  readonly schemaV: typeof MARKER_SCHEMA_V;
  /** Boot-seq of the SW that armed it + the version it ran. */
  readonly bootSeq: number;
  readonly version: string;
  readonly atTs: number;
}

export interface InstallMarker {
  readonly schemaV: typeof MARKER_SCHEMA_V;
  readonly reason: InstallReason;
  /** chrome-delivered previousVersion for reason=update (null otherwise). */
  readonly previousVersion: string | null;
  /** The version that was being installed when the stamp was written. */
  readonly version: string;
  readonly atTs: number;
}

export interface BootMarker {
  readonly schemaV: typeof MARKER_SCHEMA_V;
  /**
   * Boot counter, NON-DECREASING per device (never regresses). Torn arm-fail/
   * stamp-ok interleaves may repeat a value: the warm path's one-read law
   * cannot see a stamp fresher than the (stale) alive record it just read.
   * Informational only — no recovery decision sequences on it.
   */
  readonly bootSeq: number;
  /** Version the last COMPLETED boot ran at. */
  readonly version: string;
  readonly atTs: number;
}

/**
 * What the markers prove about THIS wake (EES-R16 taxonomy):
 *  - warm-recycle: alive present — SW recycle inside a live browser session.
 *      Nothing happened; completely invisible (no copy path ever).
 *  - first-run:    no completed boot on record and no update-stamp — W1 owns
 *      the ceremony; the marker module records, never performs.
 *  - updated:      abnormal (alive absent) AND an install stamp newer than the
 *      last completed boot OR carrying a different version — R16's guard: the
 *      restart was update-driven, copy msg.recovery.updated (card-gated §14.4).
 *  - crashed:      abnormal (alive absent) AND no update evidence — browser
 *      terminated under the same build. Copy msg.recovery.crashed (card-gated).
 *  - undetectable: the session area is unavailable or unreadable (E_CAPABILITY /
 *      storage failure) — crash detection is impossible here; NEVER fabricated
 *      as crash or update. Disclosed via gaps; BootReport lossRisk stays the
 *      reconciler's own verdict.
 */
export type BootCause = 'warm-recycle' | 'first-run' | 'updated' | 'crashed' | 'undetectable';

/** Copy keys the surfaces render (catalog is law — payloads never carry copy). */
export type RecoveryCopyKey =
  'msg.recovery.updated' | 'msg.recovery.crashed' | 'msg.heartbeat.recovered' | null;

/** Raw storage image the pure classifier consumes (IO-free, fully testable). */
export interface ClassifyInput {
  /** true when the session area exists AND the read succeeded. */
  readonly sessionReadable: boolean;
  /** Parsed alive marker (null = absent or unreadable — the input records which). */
  readonly alive: AliveMarker | null;
  /** true when the alive read SUCCEEDED and found nothing (vs. unreadable). */
  readonly aliveAbsentProven: boolean;
  readonly install: InstallMarker | null;
  readonly boot: BootMarker | null;
}

/** The classifier's full answer (cause + the evidence behind it). */
export interface BootSignal {
  readonly cause: BootCause;
  /** true ⟺ cause ∈ {updated, crashed} — abnormal termination detected. */
  readonly abnormal: boolean;
  readonly evidence: {
    readonly aliveSeen: boolean;
    readonly installReason: InstallReason | null;
    /** Version the install stamp carries (null = no stamp). */
    readonly installedVersion: string | null;
    /** Version the last COMPLETED boot ran (null = no boot stamp). */
    readonly lastBootVersion: string | null;
    readonly installedAt: number | null;
    readonly lastBootAt: number | null;
  };
  /** Disclosure strings (marker unreadable, area missing, write failures). */
  readonly gaps: readonly string[];
}

/** BootReport.bootSignal — the report section (BootReport schema v1, EES §2.13). */
export interface BootSignalSection extends BootSignal {
  /** R16/§14.4-gated copy path; computed with the reconciler's lossRisk. */
  readonly copyKey: RecoveryCopyKey;
}
