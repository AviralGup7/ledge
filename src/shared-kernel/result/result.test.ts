// E1-T08 · unit tests — envelope contract (EES §3.2) + combinators.
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_MAP } from './index.js';
import { ledgeError } from './error.js';
import { err, flatMap, isErr, isOk, map, ok, unwrapOr } from './result.js';

describe('E1-T08 error envelope', () => {
  it('every EES error code is declared', () => {
    expect(ERROR_CODES.length).toBe(27);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('every code maps to catalog keys shaped msg.error.* / msg.recover.*', () => {
    for (const code of ERROR_CODES) {
      const m = ERROR_MAP[code];
      expect(m.messageKey).toMatch(/^msg\.error\.[a-z-]+$/);
      expect(m.recoveryKey).toMatch(/^msg\.recover\.[a-z-]+$/);
      expect(typeof m.retryable).toBe('boolean');
    }
  });

  it('golden: entropy failure is exactly the §3.2 envelope', () => {
    const e = ledgeError('E_CAPABILITY_ENTROPY');
    expect(e).toEqual({
      code: 'E_CAPABILITY_ENTROPY',
      retryable: false,
      messageKey: 'msg.error.capability',
      recoveryKey: 'msg.recover.restart',
    });
  });

  it('golden: schema upcast gap carries watermark hint when given', () => {
    const e = ledgeError('E_SCHEMA_UPCAST_GAP', { type: 'TabObserved', from: 0, to: 1 }, 4811);
    expect(e).toEqual({
      code: 'E_SCHEMA_UPCAST_GAP',
      retryable: false,
      messageKey: 'msg.error.schema',
      recoveryKey: 'msg.recover.report',
      details: { type: 'TabObserved', from: 0, to: 1 },
      watermarkHint: 4811,
    });
  });

  it('rejects non-primitive details (programmer error, not a runtime mode)', () => {
    expect(() => ledgeError('E_QUOTA', { nested: { bad: true } } as never)).toThrow(TypeError);
  });
});

describe('E1-T08 Result combinators', () => {
  const fail = err(ledgeError('E_NOT_FOUND_TAB'));
  it('ok/err guards', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(fail)).toBe(true);
  });
  it('map preserves failure unchanged', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });
    expect(map(fail, (n: number) => n * 3)).toBe(fail);
  });
  it('flatMap chains or short-circuits', () => {
    expect(flatMap(ok(2), (n) => ok(n + 1))).toEqual({ ok: true, value: 3 });
    expect(flatMap(ok(2), () => fail)).toBe(fail);
    expect(flatMap(fail, (n: number) => ok(n))).toBe(fail);
  });
  it('unwrapOr yields fallback on failure', () => {
    expect(unwrapOr(ok('a'), 'b')).toBe('a');
    expect(unwrapOr(fail, 'b')).toBe('b');
  });
});
