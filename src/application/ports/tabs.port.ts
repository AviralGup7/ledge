// E3-T01 · EES §6 TabsPort — the live-tab control seam between Ledge and Chrome.
// Implemented only by src/infrastructure/chrome (A-02 adapter containment, ESLint-scoped).
// Consumed by application (hub ingest) and wired by composition roots — never by surfaces,
// AI, importers, or domain (domain doesn't know live tabs exist; it knows events).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/**
 * Adapter-normalized live-tab view. Chrome's groupId sentinel (-1) is collapsed to
 * null at the boundary; absent url/title (pending/discarded tabs) collapse to ''.
 * Only fields with a current consumer are carried (EES §6 inventory discipline).
 */
export interface TabInfo {
  readonly browserTabId: number;
  readonly windowId: number;
  readonly index: number;
  readonly groupId: number | null;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly status: 'loading' | 'complete' | null;
  readonly discarded: boolean;
}

/** Query filter (§6 query(filter)). Absent filter = all tabs in all windows. */
export interface TabsQueryFilter {
  readonly windowId?: number | undefined;
  readonly active?: boolean | undefined;
  readonly pinned?: boolean | undefined;
  readonly discarded?: boolean | undefined;
  readonly status?: 'loading' | 'complete' | undefined;
}

export interface CreateTabSpec {
  readonly url?: string | undefined;
  readonly windowId?: number | undefined;
  readonly index?: number | undefined;
  readonly active?: boolean | undefined;
}

export interface MoveTabTarget {
  readonly windowId?: number | undefined;
  readonly index: number;
}

/**
 * Normalized tab-observation stream (E2-T05 ingest consumes this union).
 * 'detached' deliberately absent: chrome pairs detaches with attaches, and the
 * Ledge event law (identity continuity) is fully served by 'attached' — a
 * detach alone never changes user truth.
 */
export type TabsEvent =
  | { readonly kind: 'created'; readonly tab: TabInfo }
  | {
      readonly kind: 'updated';
      readonly browserTabId: number;
      readonly windowId: number;
      readonly changes: TabChanges;
    }
  | {
      readonly kind: 'moved';
      readonly browserTabId: number;
      readonly windowId: number;
      readonly fromIndex: number;
      readonly toIndex: number;
    }
  | {
      readonly kind: 'attached';
      readonly browserTabId: number;
      readonly windowId: number;
      readonly newIndex: number;
    }
  | { readonly kind: 'activated'; readonly browserTabId: number; readonly windowId: number }
  | {
      readonly kind: 'removed';
      readonly browserTabId: number;
      readonly windowId: number;
      readonly isWindowClosing: boolean;
    };

/** Fields chrome.tabs.onUpdated can report (changeInfo), boundary-normalized. */
export interface TabChanges {
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: 'loading' | 'complete' | null | undefined;
  readonly pinned?: boolean | undefined;
  readonly groupId?: number | null | undefined;
  readonly discarded?: boolean | undefined;
}

/** Cancel handle for an observation stream registration. */
export interface EventSubscription {
  readonly close: () => void;
}

/**
 * §6 TabsPort behavior contract:
 *  * query(filter) → TabInfo[]   (budget: query(all) ≤50ms @500 tabs)
 *  * get(id) — missing tab is a typed E_NOT_FOUND_TAB (the caller's refresh signal).
 *  * remove(ids) → removed[] — RACE-TOLERANT LAW: an id that is already gone is
 *    skipped, not an error (remove already-gone = ok). The result lists exactly
 *    the ids this call actually closed. A capability-class failure aborts with
 *    E_CAPABILITY_API carrying the ids already closed in details.removedIds (csv).
 *  * create(spec) → browserTabId  (batched budget: ≤1s per 100 with remove)
 *  * move(ids, target) → browserTabId[] in input order (per-id, race-typed).
 *  * onEvents(handler) — listeners register synchronously (MV3 hard law); the
 *    handler must be total (§3.1 dispatch law); a throw is swallowed at the
 *    boundary, never propagated into chrome's event dispatch.
 */
export interface TabsPort {
  query(filter?: TabsQueryFilter): Promise<Result<readonly TabInfo[], LedgeError>>;
  get(browserTabId: number): Promise<Result<TabInfo, LedgeError>>;
  remove(ids: readonly number[]): Promise<Result<readonly number[], LedgeError>>;
  create(spec: CreateTabSpec): Promise<Result<number, LedgeError>>;
  move(
    ids: readonly number[],
    target: MoveTabTarget,
  ): Promise<Result<readonly number[], LedgeError>>;
  onEvents(handler: (event: TabsEvent) => void): EventSubscription;
}
