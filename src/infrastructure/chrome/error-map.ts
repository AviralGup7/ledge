// E3-T01 · EES §6 typed failures for chrome adapters — the raw lastError/rejection
// vocabulary of chrome.tabs/windows mapped onto the port's deliberately small failure
// class: E_NOT_FOUND_TAB (race signal — the entity is gone, refresh your world) and
// E_CAPABILITY_API (everything else: permission gaps, API absence, browser drift).
import { ledgeError, type LedgeError } from '@/shared-kernel/result/index.js';

/** lastError messages Chrome uses for gone entities (tabs + windows). */
const NOT_FOUND_PATTERNS: readonly string[] = [
  'No tab with id',
  'Invalid tab ID',
  'No window with id',
  'Invalid window ID',
];

const messageOf = (e: unknown): string => {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(e);
};

/** True when the rejection is a gone-entity race (remove-already-gone = ok law input). */
export const isChromeNotFound = (e: unknown): boolean => {
  const msg = messageOf(e);
  return NOT_FOUND_PATTERNS.some((p) => msg.includes(p));
};

export const mapChromeError = (e: unknown, api: string): LedgeError => {
  const raw = messageOf(e);
  return isChromeNotFound(e)
    ? ledgeError('E_NOT_FOUND_TAB', { api, raw })
    : ledgeError('E_CAPABILITY_API', { api, raw });
};

/**
 * chrome.storage rejection vocabulary (E2-T07 · EES §6 StorageAreaPort failure
 * class): quota rejections surface as E_QUOTA (session area is quota-capped;
 * callers may reason about that), every other raw failure is E_CAPABILITY_API.
 * The not-found family is absent here by design: storage get of a missing key
 * resolves with `{}`, never rejects.
 */
export const mapStorageAreaError = (e: unknown, area: string): LedgeError => {
  const raw = messageOf(e);
  return /quota/i.test(raw)
    ? ledgeError('E_QUOTA', { area, raw })
    : ledgeError('E_CAPABILITY_API', { area, raw });
};

/** Firefox parity (EES §6): the session area does not exist on this browser. */
export const sessionAreaUnavailable = (): LedgeError =>
  ledgeError('E_CAPABILITY', { area: 'session', parity: 'firefox', what: 'storage.session' });
