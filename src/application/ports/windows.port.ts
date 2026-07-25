// E3-T01 · EES §6 WindowsPort — window control seam. Same containment and
// failure class as TabsPort (E_CAPABILITY_API · E_NOT_FOUND_TAB, race-tolerant).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** Adapter-normalized window view. */
export interface WindowInfo {
  readonly windowId: number;
  readonly focused: boolean;
  /** chrome.windows type hint ('normal'|'popup'|...), lowercased, '' when unknown. */
  readonly type: string;
  /** chrome.windows state ('normal'|'minimized'|'maximized'|'fullscreen'), '' unknown. */
  readonly state: string;
}

/**
 * Window observation stream. chrome.windows.WINDOW_ID_NONE (-1) on focus-blur
 * is normalized to null — "nothing focused" is a value, not a magic number.
 */
export type WindowsEvent =
  | { readonly kind: 'created'; readonly window: WindowInfo }
  | { readonly kind: 'removed'; readonly windowId: number }
  | { readonly kind: 'focus-changed'; readonly windowId: number | null };

export interface CreateWindowSpec {
  /** Initial tabs; chrome creates them before the promise resolves (batch: one URL array). */
  readonly tabSpecs?: readonly { readonly url?: string | undefined }[] | undefined;
  readonly focused?: boolean | undefined;
}

/** Cancel handle for an observation stream registration. */
export interface WindowsEventSubscription {
  readonly close: () => void;
}

/**
 * §6 WindowsPort behavior contract:
 *  * list() → WindowInfo[]
 *  * create(spec) → windowId   (budget: create(30-tab window) ≤1.5s)
 *  * remove(id) — race-tolerant: an already-removed window is ok, not an error.
 *  * focus(id) — E_NOT_FOUND_TAB when the window is gone.
 *  * onEvents(handler) — synchronous registration (MV3), total-handler law.
 */
export interface WindowsPort {
  list(): Promise<Result<readonly WindowInfo[], LedgeError>>;
  create(spec: CreateWindowSpec): Promise<Result<number, LedgeError>>;
  remove(windowId: number): Promise<Result<void, LedgeError>>;
  focus(windowId: number): Promise<Result<void, LedgeError>>;
  onEvents(handler: (event: WindowsEvent) => void): WindowsEventSubscription;
}
