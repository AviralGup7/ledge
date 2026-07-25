// E3-APP · Error-mapping law suites — the boundary guarantees: containment of foreign
// exceptions, sanitization of internal mechanics, catalog-lawful outcomes always.
import { describe, expect, it } from 'vitest';
import { ledgeError } from '@/shared-kernel/result/index.js';
import { operationLabel, sanitizeDetails, toApplicationError } from './index.js';

describe('application error mapping (E3)', () => {
  it('passes typed errors through with operation stamped and internals stripped', () => {
    const deep = ledgeError('E_JOURNAL_INTEGRITY', {
      raw: 'crc-mismatch-segment-42',
      site: 'journal.scanner',
      suspects: 3,
      segmentId: 'seg-internal',
    });
    const mapped = toApplicationError(deep, operationLabel('command', 'RepairRebuild'));
    expect(mapped.code).toBe('E_JOURNAL_INTEGRITY'); // catalog code preserved (ADR-033 closed world)
    expect(mapped.messageKey).toBe('msg.error.journal'); // calm copy keys survive
    expect(mapped.details?.['operation']).toBe('command:RepairRebuild');
    expect(mapped.details?.['suspects']).toBe(3); // counts are UI-safe
    // mechanics never cross
    expect(mapped.details?.['raw']).toBeUndefined();
    expect(mapped.details?.['site']).toBeUndefined();
    expect(mapped.details?.['segmentId']).toBeUndefined();
  });

  it('contains foreign exceptions entirely (no message, no stack, no class name leak)', () => {
    const dexieBoom = new DOMException('ConstraintError: key already exists', 'ConstraintError');
    const mapped = toApplicationError(dexieBoom, operationLabel('query', 'GetLibrary'));
    expect(mapped.code).toBe('E_CAPABILITY');
    expect(mapped.retryable).toBe(false);
    expect(mapped.details?.['operation']).toBe('query:GetLibrary');
    expect(mapped.details?.['fault']).toBe('ConstraintError');
    expect(JSON.stringify(mapped.details)).not.toContain('key already exists');
  });

  it('degrades unknown throw shapes to the calm bucket', () => {
    const a = toApplicationError('stringly-typed horror', operationLabel('command', 'ParkAll'));
    expect(a.code).toBe('E_CAPABILITY');
    expect(a.details?.['fault']).toBe('unknown');
    const b = toApplicationError(null, operationLabel('query', 'SearchQuery'));
    expect(b.code).toBe('E_CAPABILITY');
  });

  it('sanitizeDetails caps keys and keeps flat primitives only', () => {
    const details: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) details[`k${i}`] = i;
    details['nested'] = { a: 1 };
    details['ok'] = true;
    const out = sanitizeDetails(details, 'command:Test');
    expect(Object.keys(out).length).toBe(8);
    expect(out['operation']).toBe('command:Test');
    expect(out['nested']).toBeUndefined();
  });

  it('operationLabel is the wire-audited stamp', () => {
    expect(operationLabel('command', 'ParkTab')).toBe('command:ParkTab');
    expect(operationLabel('query', 'GetTrash')).toBe('query:GetTrash');
  });
});
