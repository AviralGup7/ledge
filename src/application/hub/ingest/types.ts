// E2-T05 · Blueprint line 618 batching law ("ingest 20-events/50ms") — hub ingest types.
// The hub is the AUTHORITY (ADR-005): chrome adapter observations enter here and leave
// as §4-catalog EventEnvelopes appended to the journal through the 20/50ms batcher.
import type { TabInfo, TabsEvent } from '@/application/ports/tabs.port.js';
import type { WindowsEvent } from '@/application/ports/windows.port.js';
import type { EventTypeName } from '@/shared-kernel/events/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** Blueprint batching law constants (20 events / 50ms window). */
export const INGEST_BATCH_CAP = 20;
export const INGEST_BATCH_WINDOW_MS = 50;
/** §2.8: ack timeout is the CALLER's deadline — retry with the same idempotency key. */
export const INGEST_ACK_TIMEOUT_MS = 250;

/**
 * One normalized observation before envelope stamping (type+payload only — HLC and
 * identity are assigned at flush, inside the single-writer hub, so seqs stay
 * contiguous per batch law).
 */
export interface IngestDraft {
  readonly type: EventTypeName;
  readonly payload: Record<string, unknown>;
}

/**
 * Raw adapter observation queued at handle time (truth law: mapping/identity runs
 * only against a hydrated identity map; if the journal is momentarily unreadable
 * the observation waits in the queue, it is never dropped). ts is captured at
 * handle time — it is when Chrome SAYS the thing happened.
 */
export type PendingObservation =
  | { readonly source: 'tabs'; readonly event: TabsEvent; readonly ts: number }
  | { readonly source: 'windows'; readonly event: WindowsEvent; readonly ts: number }
  | { readonly source: 'group'; readonly input: GroupChangedInput; readonly ts: number };

/** Trackable outcomes per handle-window for health reporting. */
export interface IngestCounters {
  readonly observed: number;
  readonly updated: number;
  readonly activated: number;
  readonly closed: number;
  readonly windowsClosed: number;
  readonly groupsChanged: number;
  /** Observations for tabs Ledge never observed (race vs first-run crawl) or whose
   *  episode already closed (late post-close events): not truth, skipped. */
  readonly skippedUnknownTab: number;
}

export interface HydrationSummary {
  readonly events: number;
  readonly identities: number;
  readonly durableThrough: number;
}

export interface FlushReport {
  readonly kind: 'flush';
  readonly events: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly attempts: number;
  readonly errorCode?: string | undefined;
}

export interface FirstRunReport {
  readonly kind: 'first-run';
  /** False when the flag was already set (safe resend — §3.1 C1 idempotency). */
  readonly applied: boolean;
  readonly idempotentSkip: boolean;
  readonly missionsCreated: number;
  readonly tabsCaptured: number;
  readonly errorCode?: string | undefined;
}

export type IngestReport = FlushReport | FirstRunReport;

/** §4 GroupChanged passthrough input (chrome.tabGroups wires at E3-T02). */
export interface GroupChangedInput {
  readonly groupId: number;
  readonly name?: string | undefined;
  readonly color?: string | undefined;
  readonly collapsed?: boolean | undefined;
}

/** Timer seam — production binds setTimeout/clearTimeout; tests bind virtual time. */
export interface IngestScheduler {
  readonly after: (delayMs: number, fn: () => void) => () => void;
}

export interface IngestHubStats {
  readonly hydrated: boolean;
  readonly queued: number;
  readonly nextSeq: number;
  readonly identities: number;
}

export interface IngestHub {
  /**
   * Rebuild identity + cursors from the device stream (readRange from 0; the M1
   * wake-time path — E2-T06's boot reconciler becomes its caller). Idempotent.
   */
  hydrate(): Promise<Result<HydrationSummary, LedgeError>>;
  /** Observation sinks — total: never throw (§3.1 dispatch law). */
  handleTabsEvent(event: TabsEvent): Promise<void>;
  handleWindowsEvent(event: WindowsEvent): Promise<void>;
  handleGroupChanged(input: GroupChangedInput): Promise<void>;
  /** Flush the pending queue per the 20/50ms law (also fired by cap/window internally). */
  flush(): Promise<Result<FlushReport, LedgeError>>;
  /** §3.1 C1 — first-run crawl capture; flag-hinged, safe-resend idempotent. */
  firstRunIngest(liveTabs: readonly TabInfo[]): Promise<Result<FirstRunReport, LedgeError>>;
  counters(): IngestCounters;
  stats(): IngestHubStats;
  onReport?: ((report: IngestReport) => void) | undefined;
}
