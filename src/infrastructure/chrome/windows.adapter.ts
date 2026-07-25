// E3-T01 · EES §6 WindowsPort over chrome.windows (A-02 adapter containment).
import type {
  CreateWindowSpec,
  WindowInfo,
  WindowsEvent,
  WindowsPort,
} from '@/application/ports/windows.port.js';
import { err, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import {
  CHROME_WINDOW_ID_NONE,
  type ChromeWindowLike,
  type ChromeWindowsApi,
} from './api-surface.js';
import { isChromeNotFound, mapChromeError } from './error-map.js';

export interface WindowsAdapterDeps {
  /** Structural API seam; production binds chrome.windows. */
  readonly api?: ChromeWindowsApi | undefined;
}

const WINDOWS_API = 'windows';

const toWindowInfo = (w: ChromeWindowLike): WindowInfo => ({
  windowId: w.id ?? -1,
  focused: w.focused ?? false,
  type: w.type ?? '',
  state: w.state ?? '',
});

export function createChromeWindowsAdapter(deps: WindowsAdapterDeps = {}): WindowsPort {
  const api = (): Result<ChromeWindowsApi, LedgeError> => {
    const a =
      deps.api ??
      (typeof chrome !== 'undefined' ? (chrome.windows as ChromeWindowsApi) : undefined);
    return a === undefined
      ? err(mapChromeError(new Error('chrome.windows API unavailable'), WINDOWS_API))
      : ok(a);
  };

  return {
    async list() {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        return ok((await bound.value.getAll()).map(toWindowInfo));
      } catch (e) {
        return err(mapChromeError(e, WINDOWS_API));
      }
    },

    async create(spec: CreateWindowSpec) {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        const urls = (spec.tabSpecs ?? [])
          .map((t) => t.url)
          .filter((u): u is string => u !== undefined && u !== '');
        const created = await bound.value.create({
          ...(urls.length > 0 ? { url: urls } : {}),
          ...(spec.focused !== undefined ? { focused: spec.focused } : {}),
        });
        return ok(created.id ?? -1);
      } catch (e) {
        return err(mapChromeError(e, WINDOWS_API));
      }
    },

    async remove(windowId) {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        await bound.value.remove(windowId);
        return ok(undefined);
      } catch (e) {
        // Race-tolerant law ('same class' row, §6): already-removed = ok.
        if (isChromeNotFound(e)) return ok(undefined);
        return err(mapChromeError(e, WINDOWS_API));
      }
    },

    async focus(windowId) {
      const bound = api();
      if (!bound.ok) return bound;
      try {
        await bound.value.update(windowId, { focused: true });
        return ok(undefined);
      } catch (e) {
        return err(mapChromeError(e, WINDOWS_API));
      }
    },

    onEvents(handler) {
      const bound = api();
      if (!bound.ok) return { close: () => undefined };
      const api0 = bound.value;
      const guarded = (event: WindowsEvent): void => {
        try {
          handler(event);
        } catch {
          // Total-handler law (§3.1): nothing crosses into chrome's dispatch loop.
        }
      };
      const onCreated = (w: ChromeWindowLike): void =>
        guarded({ kind: 'created', window: toWindowInfo(w) });
      const onRemoved = (windowId: number): void => guarded({ kind: 'removed', windowId });
      const onFocusChanged = (windowId: number): void =>
        guarded({
          kind: 'focus-changed',
          windowId: windowId === CHROME_WINDOW_ID_NONE ? null : windowId,
        });
      api0.onCreated.addListener(onCreated);
      api0.onRemoved.addListener(onRemoved);
      api0.onFocusChanged.addListener(onFocusChanged);
      return {
        close: () => {
          api0.onCreated.removeListener(onCreated);
          api0.onRemoved.removeListener(onRemoved);
          api0.onFocusChanged.removeListener(onFocusChanged);
        },
      };
    },
  };
}
