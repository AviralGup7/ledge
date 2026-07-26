// E5-T01 · Tokenizer v1 goldens — latin segmentation, CJK bigrams, URL splitting,
// field fusion. These goldens ARE the version contract: a semantic change here is a
// TOKENIZER_V bump (§2.11 background-reindex law), never a silent edit.
import { describe, expect, it } from 'vitest';
import { isCjkChar, tokenizeFields, tokenizeText, tokenizeUrl, TOKENIZER_V } from './tokenizer.js';

describe('E5 tokenizer · latin runs', () => {
  it('lowercases and splits on non-word boundaries, dropping single-char runs', () => {
    expect(tokenizeText('The QUICK-brown: fox5!')).toEqual(['the', 'quick', 'brown', 'fox5']);
  });

  it('keeps digits and unicode letters inside runs', () => {
    expect(tokenizeText('café au lait — hôtel 37')).toEqual(['café', 'au', 'lait', 'hôtel', '37']);
  });

  it('single-char tokens are dropped (noise floor), empty input yields nothing', () => {
    expect(tokenizeText('a b c')).toEqual([]);
    expect(tokenizeText('')).toEqual([]);
    expect(tokenizeText('— — —')).toEqual([]);
  });
});

describe('E5 tokenizer · CJK bigram fallback', () => {
  it('segments a CJK run into overlapping bigrams', () => {
    expect(tokenizeText('東京タワー')).toEqual(['東京', '京タ', 'タワ', 'ワー']);
  });

  it('an isolated CJK char becomes a unigram; script switches flush correctly', () => {
    expect(tokenizeText('雨x')).toEqual(['雨']);
    expect(tokenizeText('研究 abc 開発')).toEqual(['研究', 'abc', '開発']);
    expect(tokenizeText('abc東京def')).toEqual(['abc', '東京', 'def']);
  });

  it('isCjkChar pins the range law', () => {
    expect(isCjkChar('東')).toBe(true);
    expect(isCjkChar('ン')).toBe(true);
    expect(isCjkChar('a')).toBe(false);
    expect(isCjkChar('5')).toBe(false);
  });
});

describe('E5 tokenizer · URL + field fusion', () => {
  it('strips the scheme and splits host/path naturally', () => {
    // `v` and `2` are single-char runs — dropped by the documented noise floor.
    expect(tokenizeUrl('https://docs.example.com/reference-guide?v=2')).toEqual([
      'docs',
      'example',
      'com',
      'reference',
      'guide',
    ]);
  });

  it('keeps schemeless URLs honest', () => {
    expect(tokenizeUrl('example.com/path')).toEqual(['example', 'com', 'path']);
  });

  it('fuses title∪domain∪url∪topics, deduped, first-occurrence order', () => {
    expect(
      tokenizeFields({
        title: 'Purple Pricing Table',
        domain: 'acme.io',
        url: 'https://acme.io/pricing/purple',
        topics: ['Sales Research'],
      }),
    ).toEqual(['purple', 'pricing', 'table', 'acme', 'io', 'sales', 'research']);
  });

  it('fields are optional without losing totality', () => {
    expect(tokenizeFields({ title: 'Only Title' })).toEqual(['only', 'title']);
    expect(tokenizeFields({ title: '' })).toEqual([]);
  });

  it('TOKENIZER_V is stamped v1 (bump law rides this constant)', () => {
    expect(TOKENIZER_V).toBe(1);
  });
});
