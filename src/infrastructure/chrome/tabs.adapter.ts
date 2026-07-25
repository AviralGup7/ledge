// E3-T01 · EES §6 TabsPort over chrome.tabs (A-02 adapter containment).
// Every port method returns Result — chrome lastError/rejections flow through
// error-map into the port's typed failure class. All chrome.Tab optionality is
// normalized at exactly one place (toTabInfo), never mid-pipeline.
import type {
  CreateTabSpec,
  MoveTabTarget,
  TabChanges,
  TabInfo,
  TabsEvent,
  TabsPort,
  TabsQueryFilter,
} from '@/application/ports/tabs.port.js';
import { err, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import {
  CHROME_GROUP_ID_NONE,
  type ChromeTabChangeInfo,
  type ChromeTabLike,
  type ChromeTabsApi,
} from './api-surface.js';
import { isChromeNotFound, mapChromeError } from './error-map.js';

export interface TabsAdapterDeps {
  /** Structural API seam; production binds chrome.tabs. */
  readonly api?: ChromeTabsApi | undefined;
}

const TABS_API = 'tabs';

/** ids → csv for E_CAPABILITY_API details (primitives-only law, §3.2). */
const csvOf = (ids: readonly number[]): string => ids.join(',');

export const toTabInfo = (tab: ChromeTabLike): TabInfo => {
  const status = tab.status;
  return {
    browserTabId: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
    groupId: tab.groupId === undefined || tab.groupId === CHROME_GROUP_ID_NONE ? null : tab.groupId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active ?? false,
    pinned: tab.pinned ?? false,
    status: status === 'loading' || status === 'complete' ? status : null,
    discarded: tab.discarded ?? false,
  };
};

const toTabChanges = (changeInfo: ChromeTabChangeInfo): TabChanges => {
  const status = changeInfo.status;
  return {
    ...(changeInfo.url !== undefined ? { url: changeInfo.url } : {}),
    ...(changeInfo.title !== undefined ? { title: changeInfo.title } : {}),
    ...(status !== undefined
      ? { status: status === 'loading' || status === 'complete' ? status : null }
      : {}),
    ...(changeInfo.pinned !== undefined ? { pinned: changeInfo.pinned } : {}),
    ...(changeInfo.groupId !== undefined
      ? { groupId: changeInfo.groupId === CHROME_GROUP_ID_NONE ? null : changeInfo.groupId }
      : {}),
    ...(changeInfo.discarded !== undefined ? { discarded: changeInfo.discarded } : {}),
  };
};

const toQueryInfo = (filter: TabsQueryFilter | undefined): Record<string, unknown> => {
  if (filter === undefined) return {};
  const out: Record<string, unknown> = {};
  if (filter.windowId !== undefined) out['windowId'] = filter.windowId;
  if (filter.active !== undefined) out['active'] = filter.active;
  if (filter.pinned !== undefined) out['pinned'] = filter.pinned;
  if (filter.discarded !== undefined) out['discarded'] = filter.discarded;
  if (filter.status !== undefined) out['status'] = filter.status;
  return out;
};

export function createChromeTabsAdapter(deps: TabsAdapterDeps = {}): TabsPort {
  /** chrome.tabs resolved lazily per call: an absent API is a typed capability
   *  failure, and MV3 service-worker rehydration re-evaluates the global anyway. */
  const api = (): Result<ChromeTabsApi, LedgeError> => {
    const a =
      deps.api ?? (typeof chrome !== 'undefined' ? (chrome.tabs as ChromeTabsApi) : undefined);
    return a === undefined
      ? err(mapChromeError(new Error('chrome.tabs API unavailable'), TABS_API))
      : ok(a);
  };

  return {
    async query(filter) {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        const tabs = await bound.value.query(toQueryInfo(filter));
        return ok(tabs.map(toTabInfo));
      } catch (e) {
        return err(mapChromeError(e, TABS_API));
      }
    },

    async get(browserTabId) {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        return ok(toTabInfo(await bound.value.get(browserTabId)));
      } catch (e) {
        return err(mapChromeError(e, TABS_API));
      }
    },

    async remove(ids) {
      const bound = api();
      if (!bound.ok) return bound;
      const removed: number[] = [];
      for (const id of ids) {
        try {
          await bound.value.remove(id);
          removed.push(id);
        } catch (e) {
          // Race-tolerant law: remove already-gone = ok (§6). Capability-class
          // failures abort with the ids already closed disclosed in details.
          if (isChromeNotFound(e)) continue;
          const mapped = mapChromeError(e, `${TABS_API}.remove`);
          return err({
            ...mapped,
            details: { ...(mapped.details ?? {}), removedIds: csvOf(removed) },
          });
        }
      }
      return ok(removed);
    },

    async create(spec: CreateTabSpec) {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        const tab = await bound.value.create({
          ...(spec.url !== undefined ? { url: spec.url } : {}),
          ...(spec.windowId !== undefined ? { windowId: spec.windowId } : {}),
          ...(spec.index !== undefined ? { index: spec.index } : {}),
          ...(spec.active !== undefined ? { active: spec.active } : {}),
        });
        return ok(tab.id ?? -1);
      } catch (e) {
        return err(mapChromeError(e, TABS_API));
      }
    },

    async move(ids, target: MoveTabTarget) {
      const bound = api();
      if (!bound.ok) return bound;
      const moved: number[] = [];
      for (const id of ids) {
        try {
          await bound.value.move(id, {
            ...(target.windowId !== undefined ? { windowId: target.windowId } : {}),
            index: target.index,
          });
          moved.push(id);
        } catch (e) {
          return err(mapChromeError(e, TABS_API));
        }
      }
      return ok(moved);
    },

    onEvents(handler) {
      const bound = api();
      if (!bound.ok) {
        // Laws may not throw at subscription time (MV3 registration is
        // synchronous); an absent API degrades to a never-firing subscription.
        return { close: () => undefined };
      }
      const api0 = bound.value;
      const guarded = (event: TabsEvent): void => {
        try {
          handler(event);
        } catch {
          // Total-handler law (§3.1): nothing crosses into chrome's dispatch loop.
        }
      };
      const onCreated = (tab: ChromeTabLike): void =>
        guarded({ kind: 'created', tab: toTabInfo(tab) });
      const onUpdated = (
        tabId: number,
        changeInfo: ChromeTabChangeInfo,
        tab: ChromeTabLike,
      ): void =>
        guarded({
          kind: 'updated',
          browserTabId: tabId,
          windowId: tab.windowId ?? -1,
          changes: toTabChanges(changeInfo),
        });
      const onMoved = (
        tabId: number,
        moveInfo: { windowId: number; fromIndex: number; toIndex: number },
      ): void => guarded({ kind: 'moved', browserTabId: tabId, ...moveInfo });
      const onAttached = (
        tabId: number,
        attachInfo: { newWindowId: number; newPosition: number },
      ): void =>
        guarded({
          kind: 'attached',
          browserTabId: tabId,
          windowId: attachInfo.newWindowId,
          newIndex: attachInfo.newPosition,
        });
      const onActivated = (activeInfo: { tabId: number; windowId: number }): void =>
        guarded({
          kind: 'activated',
          browserTabId: activeInfo.tabId,
          windowId: activeInfo.windowId,
        });
      const onRemoved = (
        tabId: number,
        removeInfo: { windowId: number; isWindowClosing: boolean },
      ): void => guarded({ kind: 'removed', browserTabId: tabId, ...removeInfo });
      api0.onCreated.addListener(onCreated);
      api0.onUpdated.addListener(onUpdated);
      api0.onMoved.addListener(onMoved);
      api0.onAttached.addListener(onAttached);
      api0.onActivated.addListener(onActivated);
      api0.onRemoved.addListener(onRemoved);
      return {
        close: () => {
          api0.onCreated.removeListener(onCreated);
          api0.onUpdated.removeListener(onUpdated);
          api0.onMoved.removeListener(onMoved);
          api0.onAttached.removeListener(onAttached);
          api0.onActivated.removeListener(onActivated);
          api0.onRemoved.removeListener(onRemoved);
        },
      };
    },
  };
}
