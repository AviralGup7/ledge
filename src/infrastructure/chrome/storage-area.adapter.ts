// E2-T07 · EES §6 StorageAreaPort over chrome.storage (A-02 adapter containment).
// The crash-marker lifecycle's only I/O seam (ADR-007 §4). Session semantics come
// from the PLATFORM, not from us: the adapter never emulates session behaviour on
// top of local, because doing so would silently corrupt the crash signal. Where
// the session area is unavailable (Firefox parity) every session op answers the
// same typed E_CAPABILITY — the marker module degrades classification to
// 'undetectable' on exactly that code, never to a guess.
import type { StorageAreaPort } from '@/application/ports/storage-area.port.js';
import { err, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { ChromeStorageApi } from './api-surface.js';
import { mapStorageAreaError, sessionAreaUnavailable } from './error-map.js';

export interface StorageAreaAdapterDeps {
  /** Structural API seam; production binds chrome.storage. */
  readonly api?: ChromeStorageApi | undefined;
}

/** Read of an absent key resolves with `null` (absence is data, not an error). */
const readFrom = async (
  area: { readonly get: (keys: string) => Promise<Record<string, unknown>> },
  key: string,
  name: string,
): Promise<Result<unknown, LedgeError>> => {
  try {
    const record = await area.get(key);
    return ok(record[key] ?? null);
  } catch (cause) {
    return err(mapStorageAreaError(cause, name));
  }
};

const writeTo = async (
  area: { readonly set: (items: Record<string, unknown>) => Promise<void> },
  key: string,
  value: unknown,
  name: string,
): Promise<Result<void, LedgeError>> => {
  try {
    await area.set({ [key]: value });
    return ok(undefined);
  } catch (cause) {
    return err(mapStorageAreaError(cause, name));
  }
};

export function createChromeStorageAreaAdapter(deps: StorageAreaAdapterDeps = {}): StorageAreaPort {
  /** Lazy ambient resolution (MV3 rehydration re-evaluates the global per wake). */
  const api = (): ChromeStorageApi | undefined =>
    deps.api ?? (typeof chrome !== 'undefined' ? (chrome.storage as ChromeStorageApi) : undefined);

  const localArea = (): Result<ChromeStorageApi['local'], LedgeError> => {
    const a = api();
    return a === undefined
      ? err(mapStorageAreaError(new Error('chrome.storage API unavailable'), 'local'))
      : ok(a.local);
  };

  const sessionArea = (): Result<NonNullable<ChromeStorageApi['session']>, LedgeError> => {
    const a = api();
    if (a === undefined) {
      return err(mapStorageAreaError(new Error('chrome.storage API unavailable'), 'session'));
    }
    return a.session === undefined ? err(sessionAreaUnavailable()) : ok(a.session);
  };

  return {
    async localGet(key) {
      const bound = localArea();
      if (!bound.ok) return bound;
      return readFrom(bound.value, key, 'local');
    },
    async localSet(key, value) {
      const bound = localArea();
      if (!bound.ok) return bound;
      return writeTo(bound.value, key, value, 'local');
    },
    async sessionGet(key) {
      const bound = sessionArea();
      if (!bound.ok) return bound;
      return readFrom(bound.value, key, 'session');
    },
    async sessionSet(key, value) {
      const bound = sessionArea();
      if (!bound.ok) return bound;
      return writeTo(bound.value, key, value, 'session');
    },
  };
}
