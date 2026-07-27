// E3-T01 · A-02 — structural typings for the Chrome API subset Ledge consumes.
// Adapters bind this interface, NOT the ambient chrome object shape: tests inject an
// in-memory implementation (testing/fake-chrome.ts) and production passes the real
// chrome.tabs / chrome.windows namespaces verbatim. Everything optional except what
// the browser guarantees, so the adapter normalizes absent fields deliberately.

/** chrome.events.Event subset (listener registering/detaching). */
export interface ChromeEventSubscription<TArgs extends readonly unknown[]> {
  readonly addListener: (callback: (...args: TArgs) => void) => void;
  readonly removeListener: (callback: (...args: TArgs) => void) => void;
}

/** Structural chrome.tabs.Tab — all fields optional; adapters must not trust presence. */
export interface ChromeTabLike {
  readonly id?: number | undefined;
  readonly windowId?: number | undefined;
  readonly index?: number | undefined;
  readonly groupId?: number | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly active?: boolean | undefined;
  readonly pinned?: boolean | undefined;
  readonly status?: string | undefined;
  readonly discarded?: boolean | undefined;
}

/** Structural chrome.tabs.onUpdated changeInfo. */
export interface ChromeTabChangeInfo {
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: string | undefined;
  readonly pinned?: boolean | undefined;
  readonly groupId?: number | undefined;
  readonly discarded?: boolean | undefined;
}

export interface ChromeTabCreateProps {
  readonly url?: string | undefined;
  readonly windowId?: number | undefined;
  readonly index?: number | undefined;
  readonly active?: boolean | undefined;
}

export interface ChromeTabMoveProps {
  readonly windowId?: number | undefined;
  readonly index: number;
}

// ---------------------------------------------------------------------------
// E2-T07 · chrome.storage subset (crash-marker lifecycle, EES §6 StorageAreaPort).
// `session` is OPTIONAL on the structural type: Firefox parity — where the area
// is missing the adapter answers typed E_CAPABILITY, never re-routes to local.
// ---------------------------------------------------------------------------

/** chrome.storage.StorageArea subset (get/set only — markers + hot flags' needs). */
export interface ChromeStorageAreaLike {
  readonly get: (keys: string) => Promise<Record<string, unknown>>;
  readonly set: (items: Record<string, unknown>) => Promise<void>;
}

/** chrome.storage namespace subset. */
export interface ChromeStorageApi {
  readonly local: ChromeStorageAreaLike;
  readonly session?: ChromeStorageAreaLike | undefined;
}

export interface ChromeTabsApi {
  readonly query: (queryInfo: Record<string, unknown>) => Promise<ChromeTabLike[]>;
  readonly get: (tabId: number) => Promise<ChromeTabLike>;
  readonly remove: (tabIds: number | readonly number[]) => Promise<void>;
  readonly create: (createProperties: ChromeTabCreateProps) => Promise<ChromeTabLike>;
  readonly move: (
    tabIds: number | readonly number[],
    moveProperties: ChromeTabMoveProps,
  ) => Promise<ChromeTabLike | readonly ChromeTabLike[]>;
  readonly onCreated: ChromeEventSubscription<[tab: ChromeTabLike]>;
  readonly onUpdated: ChromeEventSubscription<
    [tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTabLike]
  >;
  readonly onMoved: ChromeEventSubscription<
    [tabId: number, moveInfo: { windowId: number; fromIndex: number; toIndex: number }]
  >;
  readonly onAttached: ChromeEventSubscription<
    [tabId: number, attachInfo: { newWindowId: number; newPosition: number }]
  >;
  readonly onActivated: ChromeEventSubscription<[activeInfo: { tabId: number; windowId: number }]>;
  readonly onRemoved: ChromeEventSubscription<
    [tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }]
  >;
}

/** Structural chrome.windows.Window. */
export interface ChromeWindowLike {
  readonly id?: number | undefined;
  readonly focused?: boolean | undefined;
  readonly type?: string | undefined;
  readonly state?: string | undefined;
}

export interface ChromeWindowCreateData {
  readonly url?: string | readonly string[] | undefined;
  readonly focused?: boolean | undefined;
}

export interface ChromeWindowsApi {
  readonly getAll: (getInfo?: Record<string, unknown>) => Promise<ChromeWindowLike[]>;
  readonly create: (createData?: ChromeWindowCreateData) => Promise<ChromeWindowLike>;
  readonly remove: (windowId: number) => Promise<void>;
  readonly update: (
    windowId: number,
    updateInfo: { focused?: boolean | undefined },
  ) => Promise<ChromeWindowLike>;
  readonly onCreated: ChromeEventSubscription<[window: ChromeWindowLike]>;
  readonly onRemoved: ChromeEventSubscription<[windowId: number]>;
  readonly onFocusChanged: ChromeEventSubscription<[windowId: number]>;
}

/** chrome.tabGroups.TAB_GROUP_ID_NONE — collapsed to null at the adapter boundary. */
export const CHROME_GROUP_ID_NONE = -1;
/** chrome.windows.WINDOW_ID_NONE — collapsed to null on focus-changed. */
export const CHROME_WINDOW_ID_NONE = -1;

// ─── E3-T03 · sessions (recovery cross-check reads) ───────────────────────────

/** A session's tab ride-along: a chrome.Tab plus its stable session id. */
export interface ChromeSessionTabLike extends ChromeTabLike {
  readonly sessionId?: string | undefined;
}

/** A closed-window session entry: the window summary plus its tab list. */
export interface ChromeSessionWindowLike extends ChromeWindowLike {
  readonly sessionId?: string | undefined;
  readonly tabs?: readonly ChromeSessionTabLike[] | undefined;
}

/** chrome.sessions.Session — exactly one of tab/window is present per entry. */
export interface ChromeSessionLike {
  readonly lastModified?: number | undefined;
  readonly tab?: ChromeSessionTabLike | undefined;
  readonly window?: ChromeSessionWindowLike | undefined;
}

/**
 * chrome.sessions as Ledge reads it. READ-ONLY LAW (E3-T03 roadmap row): the
 * surface deliberately omits `restore`/`getDevices` — recovery reads the backlog
 * to cross-check, it never lets the platform mutate session state on our behalf.
 */
export interface ChromeSessionsApi {
  readonly getRecentlyClosed: (filter?: {
    readonly maxResults?: number | undefined;
  }) => Promise<ChromeSessionLike[]>;
}

// ─── E3-T07 · offscreen (workroom document lifecycle) ────────────────────────

/**
 * chrome.offscreen as Ledge drives it (E3-T07 roadmap row "OffscreenPort +
 * workroom skeleton"). The structural mirror pins ONLY the lifecycle quartet;
 * job payloads never cross this seam (they ride §3.6 runtime messages). Chrome
 * versions differ in promise-vs-callback shape on hasDocument — the adapter
 * normalizes at the boundary like every other api-surface promise here.
 */
export interface ChromeOffscreenCreateParameters {
  readonly url: string;
  readonly reasons: readonly string[];
  readonly justification: string;
}

export interface ChromeOffscreenApi {
  readonly hasDocument: () => Promise<boolean>;
  readonly createDocument: (parameters: ChromeOffscreenCreateParameters) => Promise<void>;
  readonly closeDocument: () => Promise<void>;
}
