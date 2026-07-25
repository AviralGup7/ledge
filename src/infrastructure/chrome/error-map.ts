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
