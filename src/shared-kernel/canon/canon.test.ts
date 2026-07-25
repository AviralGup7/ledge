// E1-T06 · golden corpus runner + spot laws (EES §13 kernel golden tables).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize, fnv1a64 } from './index.js';

interface GoldenCase {
  raw: string;
  canonForm?: string;
  schemeOk: boolean;
  domain?: string;
  note: string;
}

const corpus = JSON.parse(readFileSync('ops/fixtures/canon/canon.golden.json', 'utf8')) as {
  cases: GoldenCase[];
};

describe('E1-T06 golden corpus (ops/fixtures/canon)', () => {
  for (const c of corpus.cases) {
    it(`[${c.note}] ${c.raw}`, () => {
      const r = canonicalize(c.raw);
      expect(r.schemeOk, `schemeOk for ${c.raw}`).toBe(c.schemeOk);
      if (c.canonForm !== undefined) expect(r.canonForm).toBe(c.canonForm);
      if (c.domain !== undefined) expect(r.domain).toBe(c.domain);
      if (!c.schemeOk) {
        // Fallback law: exact-match material is the raw input, and it never throws.
        expect(r.canonForm).toBe(c.raw);
        expect(r.canonHash).toBe(fnv1a64(c.raw));
        expect(r.domain).toBe('');
      }
    });
  }

  it('every successful case is idempotent at golden level', () => {
    for (const c of corpus.cases) {
      const once = canonicalize(c.raw);
      const twice = canonicalize(once.canonForm);
      expect(twice.canonForm, `idempotence for ${c.raw}`).toBe(once.canonForm);
      expect(twice.canonHash).toBe(once.canonHash);
    }
  });
});

describe('E1-T06 spot laws', () => {
  it('fragment-sensitive routes stay distinct (the ADR-016 reason fragments live)', () => {
    const a = canonicalize('https://example.com/app#/a');
    const b = canonicalize('https://example.com/app#/b');
    expect(a.canonForm).not.toBe(b.canonForm);
    expect(a.canonHash).not.toBe(b.canonHash);
  });

  it('rulesVersion provenance is stamped from the shipped table', () => {
    expect(canonicalize('https://example.com/').rulesVersion).toBe(1);
  });

  it('fnv1a64 is deterministic hex-16 and input-sensitive', () => {
    expect(fnv1a64('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64('a')).toBe(fnv1a64('a'));
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
  });
});
