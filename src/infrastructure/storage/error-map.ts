// E1-T09 · ADR-026/ADR-012 — every raw IndexedDB/Dexie failure becomes a typed LedgeError.
// Mapping is by DOMException/Dexie error NAME (IDB has no typed hierarchy worth trusting
// across browsers), with a conservative default: an unlisted name during open/txn is
// corruption-class — §2.9's rescue path errs safe, never optimistically continues.
// Unit-tested with synthetic DOMExceptions (src/infrastructure/storage/error-map.test.ts).
import { ledgeError, type LedgeError } from '@/shared-kernel/result/index.js';

/** Where the failure surfaced — shapes the conservative default. */
export type FailureSite = 'open' | 'txn' | 'quota' | 'persist';

const errorName = (e: unknown): string => {
  if (typeof e === 'object' && e !== null && 'name' in e) {
    const n = (e as { name: unknown }).name;
    if (typeof n === 'string') return n;
  }
  return typeof e;
};

export function mapStorageError(e: unknown, site: FailureSite): LedgeError {
  const name = errorName(e);
  switch (name) {
    case 'QuotaExceededError': // IDB write past quota; also navigator estimate guards
      return ledgeError('E_QUOTA', { site, raw: name });
    case 'VersionError': // existing DB has a higher/unknown version — migration jurisdiction
    case 'UpgradeError':
    case 'MigrationError':
      return ledgeError('E_MIGRATION', { site, raw: name });
    case 'InvalidStateError': // DB deleted/blocked mid-open; versionchange blocked
    case 'InvalidAccessError':
    case 'MissingAPIError': // indexedDB absent entirely (Dexie.MissingAPIError)
    case 'DatabaseClosedError':
      return ledgeError('E_CORRUPT_STORE', { site, raw: name });
    case 'AbortError': // txn aborted — our own abort reaches callers as Result-err before this;
    case 'TransactionInactiveError': // leftover is corruption-class by §2.9 conservative law
    case 'UnknownError':
    case 'DataError':
    case 'ConstraintError':
    case 'SchemaError': // undeclared store/index named by caller — bug signal stays in details.raw
      return ledgeError('E_CORRUPT_STORE', { site, raw: name });
    default:
      // Unlisted name: conservative. Quota probing misbehaving is not corruption — an
      // estimate failure means "quota unknown", surfaced as capability, not rescue.
      return site === 'quota' || site === 'persist'
        ? ledgeError('E_CAPABILITY', { site, raw: name })
        : ledgeError('E_CORRUPT_STORE', { site, raw: name });
  }
}
