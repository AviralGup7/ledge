// Golden CRC-32 vectors (E2-T01). The standard suite ("123456789" → cbf43926) pins the
// implementation to the published ISO-HDLC table; unicode vectors pin the UTF-8 codec.
import { describe, expect, it } from 'vitest';
import { crc32Hex, CRC32_HEX_LENGTH } from './crc32.js';
import { stableStringify } from './stable-stringify.js';

describe('crc32Hex — published check values', () => {
  const GOLDENS: ReadonlyArray<readonly [string, string]> = [
    ['', '00000000'],
    ['a', 'e8b7be43'],
    ['abc', '352441c2'],
    ['message digest', '20159d7f'],
    ['abcdefghijklmnopqrstuvwxyz', '4c2750bd'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '1fc2e6d2'],
    ['123456789', 'cbf43926'],
    ['1234567890', '261daee5'],
    ['The quick brown fox jumps over the lazy dog', '414fa339'],
  ];

  for (const [input, expected] of GOLDENS) {
    it(`crc32(${JSON.stringify(input).slice(0, 24)}…) = ${expected}`, () => {
      const got = crc32Hex(input);
      expect(got).toBe(expected);
      expect(got).toHaveLength(CRC32_HEX_LENGTH);
    });
  }
});

describe('stableStringify — canonical crc images', () => {
  it('key order never changes the image', () => {
    const a = stableStringify({ b: 1, a: { d: [true, null], c: 'x' } });
    const b = stableStringify({ a: { c: 'x', d: [true, null] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
  });

  it('crc over equal-but-differently-ordered objects is identical', () => {
    expect(crc32Hex(stableStringify({ x: [1, 2], y: 'z' }))).toBe(
      crc32Hex(stableStringify({ y: 'z', x: [1, 2] })),
    );
  });
});
