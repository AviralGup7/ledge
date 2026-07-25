// E3-T01 · TEST-ONLY in-memory chrome.tabs/windows implementation (ADR-032 binding #2
// for the chrome adapters — contract suite runs against this and reference Chrome).
// Mirrors chrome's observable semantics: event names/order for create/activate/remove/
// move/attach flows, window-close cascades (isWindowClosing:true), WINDOW_ID_NONE and
// GROUP_ID_NONE sentinels, lastError-shaped rejections ("No tab with id: N" — the exact
// string error-map matches). Deterministic id allocation, one-shot sabotage seam for
// the capability-failure law.
import {
  CHROME_GROUP_ID_NONE,
  CHROME_WINDOW_ID_NONE,
  type ChromeEventSubscription,
  type ChromeStorageApi,
  type ChromeStorageAreaLike,
  type ChromeTabChangeInfo,
  type ChromeTabCreateProps,
  type ChromeTabLike,
  type ChromeTabMoveProps,
  type ChromeTabsApi,
  type ChromeWindowCreateData,
  type ChromeWindowLike,
  type ChromeWindowsApi,
} from '../api-surface.js';

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  groupId: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  status: string;
  discarded: boolean;
}

interface FakeWindow {
  id: number;
  type: string;
  state: string;
  tabIds: number[];
}

const FIRST_DEFAULT = 1;
const NEWTAB_URL = 'chrome://newtab/';
const WINDOW_TYPE = 'normal';
const WINDOW_STATE = 'normal';

const notFoundTab = (id: number): Error => new Error(`No tab with id: ${id}`);
const notFoundWindow = (id: number): Error => new Error(`No window with id: ${id}`);

interface EventBus<TArgs extends readonly unknown[]> {
  readonly api: ChromeEventSubscription<TArgs>;
  readonly fire: (...args: TArgs) => void;
}

const makeEvent = <TArgs extends readonly unknown[]>(): EventBus<TArgs> => {
  const listeners = new Set<(...args: TArgs) => void>();
  return {
    api: {
      addListener: (cb) => {
        listeners.add(cb);
      },
      removeListener: (cb) => {
        listeners.delete(cb);
      },
    },
    fire: (...args) => {
      for (const cb of [...listeners]) cb(...args);
    },
  };
};

export interface FakeChromeOptions {
  readonly firstTabId?: number | undefined;
  readonly firstWindowId?: number | undefined;
  /** E2-T07 · Firefox parity simulation: storage.session does not exist. */
  readonly disableSession?: boolean | undefined;
}

export interface FakeChrome {
  readonly tabs: ChromeTabsApi;
  readonly windows: ChromeWindowsApi;
  readonly storage: ChromeStorageApi;
  readonly hooks: {
    /** Drive an onUpdated turn (changeInfo echoed verbatim, chrome-style). */
    readonly updateTab: (tabId: number, changeInfo: ChromeTabChangeInfo) => void;
    readonly activateTab: (tabId: number) => void;
    /** One-shot sabotage: the NEXT api call (tabs or windows) rejects with `cause`. */
    readonly sabotageNext: (cause: unknown) => void;
    /** E2-T07 · one-shot sabotage scoped to the NEXT storage-area call. */
    readonly sabotageStorageNext: (cause: unknown) => void;
    /**
     * E2-T07 · browser-restart simulation (ADR-007 §4): session storage dies,
     * local persists. SW recycling is simulated by simply NOT calling this.
     */
    readonly clearSessionArea: () => void;
    /** Raw inspection for assertions. */
    readonly tabIdsInWindow: (windowId: number) => readonly number[];
    readonly rawTab: (tabId: number) => ChromeTabLike | undefined;
    readonly focusedWindowId: () => number;
    /** E2-T07 · raw area contents (assertion seam for marker records). */
    readonly storageDump: (area: 'local' | 'session') => Record<string, unknown>;
  };
}

export function createFakeChrome(opts: FakeChromeOptions = {}): FakeChrome {
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, FakeWindow>();
  let nextTabId = opts.firstTabId ?? FIRST_DEFAULT;
  let nextWindowId = (opts.firstWindowId ?? FIRST_DEFAULT) + 1;
  let focusedId = opts.firstWindowId ?? FIRST_DEFAULT;
  let sabotage: unknown;

  const firstWindow: FakeWindow = {
    id: opts.firstWindowId ?? FIRST_DEFAULT,
    type: WINDOW_TYPE,
    state: WINDOW_STATE,
    tabIds: [],
  };
  windows.set(firstWindow.id, firstWindow);

  const bus = {
    tabCreated: makeEvent<[tab: ChromeTabLike]>(),
    tabUpdated: makeEvent<[tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTabLike]>(),
    tabMoved:
      makeEvent<
        [tabId: number, moveInfo: { windowId: number; fromIndex: number; toIndex: number }]
      >(),
    tabAttached:
      makeEvent<[tabId: number, attachInfo: { newWindowId: number; newPosition: number }]>(),
    tabActivated: makeEvent<[activeInfo: { tabId: number; windowId: number }]>(),
    tabRemoved:
      makeEvent<[tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }]>(),
    windowCreated: makeEvent<[window: ChromeWindowLike]>(),
    windowRemoved: makeEvent<[windowId: number]>(),
    windowFocusChanged: makeEvent<[windowId: number]>(),
  };

  const consumeSabotage = (): unknown => {
    const s = sabotage;
    sabotage = undefined;
    return s;
  };

  // --- E2-T07 · storage areas (chrome.storage semantics) ---------------------
  // local persists across `clearSessionArea()` (browser restart); session dies.
  // Values pass through byte-identical (chrome.storage JSON covenant is the
  // caller's duty — the fake, like chrome, does no schema validation).
  const localData = new Map<string, unknown>();
  let sessionData = new Map<string, unknown>();
  let storageSabotage: unknown;

  const consumeStorageSabotage = (): unknown => {
    const s = storageSabotage;
    storageSabotage = undefined;
    return s;
  };

  const makeArea = (data: () => Map<string, unknown>): ChromeStorageAreaLike => ({
    get: (keys: string) => {
      const s = consumeStorageSabotage();
      if (s !== undefined) return Promise.reject(s);
      const record: Record<string, unknown> = {};
      const value = data().get(keys);
      if (value !== undefined) record[keys] = value;
      return Promise.resolve(record);
    },
    set: (items: Record<string, unknown>) => {
      const s = consumeStorageSabotage();
      if (s !== undefined) return Promise.reject(s);
      for (const [k, v] of Object.entries(items)) data().set(k, v);
      return Promise.resolve();
    },
  });

  const storageApi: ChromeStorageApi = {
    local: makeArea(() => localData),
    ...(opts.disableSession === true ? {} : { session: makeArea(() => sessionData) }),
  };

  const copy = (t: FakeTab): ChromeTabLike => ({ ...t });
  const windowInfo = (w: FakeWindow): ChromeWindowLike => ({
    id: w.id,
    focused: w.id === focusedId,
    type: w.type,
    state: w.state,
  });

  const reindex = (windowId: number): void => {
    const w = windows.get(windowId);
    if (w === undefined) return;
    w.tabIds.forEach((tid, i) => {
      const t = tabs.get(tid);
      if (t !== undefined) t.index = i;
    });
  };

  const activateInWindow = (tab: FakeTab): void => {
    for (const t of tabs.values()) {
      if (t.windowId === tab.windowId && t.active) t.active = false;
    }
    tab.active = true;
    bus.tabActivated.fire({ tabId: tab.id, windowId: tab.windowId });
  };

  const createTabIn = (
    windowId: number,
    props: { url?: string | undefined; index?: number | undefined; active?: boolean | undefined },
  ): FakeTab => {
    const w = windows.get(windowId);
    if (w === undefined) throw notFoundWindow(windowId);
    const tab: FakeTab = {
      id: nextTabId++,
      windowId,
      index: w.tabIds.length,
      groupId: CHROME_GROUP_ID_NONE,
      url: props.url ?? NEWTAB_URL,
      title: '',
      active: false,
      pinned: false,
      status: 'complete',
      discarded: false,
    };
    const at = props.index === undefined ? w.tabIds.length : Math.min(props.index, w.tabIds.length);
    w.tabIds.splice(at, 0, tab.id);
    tabs.set(tab.id, tab);
    reindex(windowId);
    bus.tabCreated.fire(copy(tab));
    if (props.active ?? true) activateInWindow(tab);
    return tab;
  };

  const removeTabInternal = (tabId: number, isWindowClosing: boolean): void => {
    const t = tabs.get(tabId);
    if (t === undefined) throw notFoundTab(tabId);
    const w = windows.get(t.windowId);
    if (w !== undefined) {
      w.tabIds = w.tabIds.filter((x) => x !== tabId);
    }
    const wasActive = t.active;
    tabs.delete(tabId);
    if (w !== undefined) reindex(w.id);
    bus.tabRemoved.fire(tabId, { windowId: t.windowId, isWindowClosing });
    // Chrome activates a neighbour when the active tab goes (and the window survives).
    if (wasActive && !isWindowClosing && w !== undefined && w.tabIds.length > 0) {
      const neighbourId = w.tabIds[Math.min(t.index, w.tabIds.length - 1)];
      const neighbour = neighbourId === undefined ? undefined : tabs.get(neighbourId);
      if (neighbour !== undefined) activateInWindow(neighbour);
    }
  };

  const tabsApi: ChromeTabsApi = {
    query: (queryInfo) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const rows = [...tabs.values()]
        .filter((t) => {
          if (queryInfo['windowId'] !== undefined && t.windowId !== queryInfo['windowId'])
            return false;
          if (queryInfo['active'] !== undefined && t.active !== queryInfo['active']) return false;
          if (queryInfo['pinned'] !== undefined && t.pinned !== queryInfo['pinned']) return false;
          if (queryInfo['discarded'] !== undefined && t.discarded !== queryInfo['discarded'])
            return false;
          if (queryInfo['status'] !== undefined && t.status !== queryInfo['status']) return false;
          return true;
        })
        .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
        .map(copy);
      return Promise.resolve(rows);
    },
    get: (tabId) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const t = tabs.get(tabId);
      return t === undefined ? Promise.reject(notFoundTab(tabId)) : Promise.resolve(copy(t));
    },
    remove: (tabIds) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const list = Array.isArray(tabIds) ? tabIds : [tabIds];
      try {
        for (const id of list) removeTabInternal(id as number, false);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return Promise.resolve();
    },
    create: (props: ChromeTabCreateProps) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      try {
        const windowId = props.windowId ?? focusedId;
        return Promise.resolve(copy(createTabIn(windowId, props)));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    move: (tabIds, moveProps: ChromeTabMoveProps) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const list = Array.isArray(tabIds) ? tabIds : [tabIds];
      const out: ChromeTabLike[] = [];
      try {
        for (const rawId of list) {
          const id = rawId as number;
          const t = tabs.get(id);
          if (t === undefined) throw notFoundTab(id);
          const targetWindowId = moveProps.windowId ?? t.windowId;
          const targetWindow = windows.get(targetWindowId);
          if (targetWindow === undefined) throw notFoundWindow(targetWindowId);
          const fromIndex = t.index;
          const sourceWindow = windows.get(t.windowId);
          if (sourceWindow === undefined) throw notFoundWindow(t.windowId);
          sourceWindow.tabIds = sourceWindow.tabIds.filter((x) => x !== id);
          const at = Math.min(Math.max(moveProps.index, 0), targetWindow.tabIds.length);
          targetWindow.tabIds.splice(at, 0, id);
          t.windowId = targetWindowId;
          reindex(sourceWindow.id);
          reindex(targetWindow.id);
          if (targetWindowId === sourceWindow.id) {
            bus.tabMoved.fire(id, { windowId: targetWindowId, fromIndex, toIndex: t.index });
          } else {
            bus.tabAttached.fire(id, { newWindowId: targetWindowId, newPosition: t.index });
          }
          out.push(copy(t));
        }
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return Promise.resolve(Array.isArray(tabIds) ? out : (out[0] ?? ({} as ChromeTabLike)));
    },
    onCreated: bus.tabCreated.api,
    onUpdated: bus.tabUpdated.api,
    onMoved: bus.tabMoved.api,
    onAttached: bus.tabAttached.api,
    onActivated: bus.tabActivated.api,
    onRemoved: bus.tabRemoved.api,
  };

  const windowsApi: ChromeWindowsApi = {
    getAll: () => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      return Promise.resolve([...windows.values()].map(windowInfo));
    },
    create: (createData?: ChromeWindowCreateData) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const w: FakeWindow = {
        id: nextWindowId++,
        type: WINDOW_TYPE,
        state: WINDOW_STATE,
        tabIds: [],
      };
      windows.set(w.id, w);
      bus.windowCreated.fire(windowInfo(w));
      const urls = createData?.url;
      const list = urls === undefined ? [undefined] : Array.isArray(urls) ? urls : [urls as string];
      const made: FakeTab[] = [];
      for (const url of list) {
        made.push(createTabIn(w.id, { url, active: false }));
      }
      const focused = createData?.focused ?? true;
      if (focused) {
        focusedId = w.id;
        bus.windowFocusChanged.fire(w.id);
        const first = made[0];
        if (first !== undefined) activateInWindow(first);
      }
      return Promise.resolve(windowInfo(w));
    },
    remove: (windowId) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const w = windows.get(windowId);
      if (w === undefined) return Promise.reject(notFoundWindow(windowId));
      const wasFocused = windowId === focusedId;
      for (const tid of [...w.tabIds]) removeTabInternal(tid, true);
      windows.delete(windowId);
      bus.windowRemoved.fire(windowId);
      if (wasFocused) {
        focusedId = CHROME_WINDOW_ID_NONE;
        bus.windowFocusChanged.fire(CHROME_WINDOW_ID_NONE);
      }
      return Promise.resolve();
    },
    update: (windowId, updateInfo) => {
      const s = consumeSabotage();
      if (s !== undefined) return Promise.reject(s);
      const w = windows.get(windowId);
      if (w === undefined) return Promise.reject(notFoundWindow(windowId));
      if (updateInfo.focused === true && focusedId !== windowId) {
        focusedId = windowId;
        bus.windowFocusChanged.fire(windowId);
      }
      return Promise.resolve(windowInfo(w));
    },
    onCreated: bus.windowCreated.api,
    onRemoved: bus.windowRemoved.api,
    onFocusChanged: bus.windowFocusChanged.api,
  };

  return {
    tabs: tabsApi,
    windows: windowsApi,
    storage: storageApi,
    hooks: {
      updateTab: (tabId, changeInfo) => {
        const t = tabs.get(tabId);
        if (t === undefined) return;
        if (changeInfo.url !== undefined) t.url = changeInfo.url;
        if (changeInfo.title !== undefined) t.title = changeInfo.title;
        if (changeInfo.status !== undefined) t.status = changeInfo.status;
        if (changeInfo.pinned !== undefined) t.pinned = changeInfo.pinned;
        if (changeInfo.groupId !== undefined) t.groupId = changeInfo.groupId;
        if (changeInfo.discarded !== undefined) t.discarded = changeInfo.discarded;
        bus.tabUpdated.fire(tabId, changeInfo, copy(t));
      },
      activateTab: (tabId) => {
        const t = tabs.get(tabId);
        if (t === undefined || t.active) return;
        activateInWindow(t);
      },
      sabotageNext: (cause) => {
        sabotage = cause;
      },
      sabotageStorageNext: (cause) => {
        storageSabotage = cause;
      },
      clearSessionArea: () => {
        sessionData = new Map();
      },
      tabIdsInWindow: (windowId) => [...(windows.get(windowId)?.tabIds ?? [])],
      rawTab: (tabId) => {
        const t = tabs.get(tabId);
        return t === undefined ? undefined : copy(t);
      },
      focusedWindowId: () => focusedId,
      storageDump: (area) => Object.fromEntries(area === 'local' ? localData : sessionData),
    },
  };
}
