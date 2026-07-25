// E1-T09 unit tests — storage failure mapping (ADR-026 envelope, ADR-012 never-unmapped).
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@/shared-kernel/result/error-codes.catalog.js';
import { mapStorageError } from './error-map.js';

const named = (name: string): object => Object.assign(new Error('boom'), { name });

describe('mapStorageError', () => {
  it('maps QuotaExceededError to E_QUOTA regardless of site', () => {
    for (const site of ['open', 'txn', 'quota', 'persist'] as const) {
      expect(mapStorageError(named('QuotaExceededError'), site).code).toBe('E_QUOTA');
    }
  });

  it('maps version-schema conflicts to E_MIGRATION (ADR-034 jurisdiction)', () => {
    for (const name of ['VersionError', 'UpgradeError', 'MigrationError']) {
      expect(mapStorageError(named(name), 'open').code).toBe('E_MIGRATION');
    }
  });

  it('maps integrity-class IDB failures to E_CORRUPT_STORE', () => {
    for (const name of [
      'InvalidStateError',
      'InvalidAccessError',
      'MissingAPIError',
      'DatabaseClosedError',
      'AbortError',
      'TransactionInactiveError',
      'UnknownError',
      'DataError',
      'ConstraintError',
      'SchemaError',
    ]) {
      expect(mapStorageError(named(name), 'txn').code).toBe('E_CORRUPT_STORE');
    }
  });

  it('is conservative: unknown names at open/txn are corruption-class', () => {
    expect(mapStorageError(named('FutureWeirdError'), 'txn').code).toBe('E_CORRUPT_STORE');
    expect(mapStorageError(named('FutureWeirdError'), 'open').code).toBe('E_CORRUPT_STORE');
    expect(mapStorageError('not even an object', 'txn').code).toBe('E_CORRUPT_STORE');
  });

  it('quota/persist probes degrade to E_CAPABILITY, never fake corruption', () => {
    expect(mapStorageError(named('FutureWeirdError'), 'quota').code).toBe('E_CAPABILITY');
    expect(mapStorageError(named('FutureWeirdError'), 'persist').code).toBe('E_CAPABILITY');
  });

  it('never produces an unmapped code and carries primitive details only (EES §3.2)', () => {
    const e = mapStorageError(named('QuotaExceededError'), 'txn');
    expect((ERROR_CODES as readonly string[]).includes(e.code)).toBe(true);
    expect(e.messageKey.startsWith('msg.')).toBe(true);
    expect(e.recoveryKey.startsWith('msg.recover.')).toBe(true);
    for (const v of Object.values(e.details ?? {})) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof v); // null reads as object
    }
  });

  it('keeps the raw browser name in details for diagnostics', () => {
    expect(mapStorageError(named('ConstraintError'), 'txn').details?.['raw']).toBe(
      'ConstraintError',
    );
  });
});
