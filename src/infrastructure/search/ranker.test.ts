// E5-T01 · BM25-lite ranker goldens — idf monotonicity, tf saturation, length
// normalization, recency/open-state boosts (never sign-flipping), degenerate-corpus
// totality. Constants ride RANK (tunable without schema change — ADR-015).
import { describe, expect, it } from 'vitest';
import { bm25Term, boostOf, idfOf, RANK, scoreOf, type PostingEntry } from './ranker.js';

const posting = (over: Partial<PostingEntry>): PostingEntry => ({
  id: 't1',
  tf: 1,
  dl: 10,
  st: 'kept',
  la: 0,
  ...over,
});

describe('E5 ranker · BM25 core', () => {
  it('idf is non-negative and shrinks as df grows', () => {
    expect(idfOf(1000, 1)).toBeGreaterThan(idfOf(1000, 10));
    expect(idfOf(1000, 10)).toBeGreaterThan(idfOf(1000, 1000));
    expect(idfOf(0, 0)).toBeGreaterThanOrEqual(0);
  });

  it('tf saturates (sub-linear growth) and length-normalizes long docs down', () => {
    const a = bm25Term(1, posting({ tf: 1, dl: 10 }), 10);
    const b = bm25Term(1, posting({ tf: 4, dl: 10 }), 10);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(a * 4); // saturation: tf 4× scores < 4×
    const long = bm25Term(1, posting({ tf: 1, dl: 100 }), 10);
    expect(long).toBeLessThan(a); // same tf in a longer doc loses
  });

  it('degenerate corpus (avgdl 0) never throws and still discriminates tf', () => {
    expect(bm25TerminateSafe()).toBe(true);
  });
});

const bm25TerminateSafe = (): boolean => {
  const low = bm25Term(1, posting({ tf: 1, dl: 10 }), 0);
  const high = bm25Term(1, posting({ tf: 3, dl: 10 }), 0);
  return Number.isFinite(low) && Number.isFinite(high) && high > low;
};

describe('E5 ranker · boosts', () => {
  const now = 1_950_000_000_000;

  it('recency boost decays toward 1 as activity ages', () => {
    const fresh = boostOf(posting({ la: now - 1000 }), now);
    const week = boostOf(posting({ la: now - 604_800_000 }), now);
    const ancient = boostOf(posting({ la: now - 86_400_000_000 }), now);
    expect(fresh).toBeGreaterThan(week);
    expect(week).toBeGreaterThan(ancient);
    expect(ancient).toBeGreaterThanOrEqual(1); // boosts never flip sign
  });

  it('live (open) boost stacks over kept', () => {
    const kept = boostOf(posting({ la: now, st: 'kept' }), now);
    const live = boostOf(posting({ la: now, st: 'live' }), now);
    expect(live).toBeCloseTo(kept + RANK.LIVE_BOOST, 5);
  });

  it('future activity clamps at age 0 (clock skew totality)', () => {
    const future = boostOf(posting({ la: now + 10_000 }), now);
    expect(future).toBeGreaterThanOrEqual(1);
  });
});

describe('E5 ranker · score composition', () => {
  it('sums per-term BM25 and multiplies the composed boost', () => {
    const now = 1_950_000_000_000;
    const t1 = posting({ id: 'x', tf: 2, dl: 12, la: now });
    const t2 = posting({ id: 'x', tf: 1, dl: 12, la: now });
    const total = scoreOf(
      [
        { idf: 2, posting: t1 },
        { idf: 2, posting: t2 },
      ],
      12,
      now,
    );
    expect(total).toBeGreaterThan(0);
    const liveTotal = scoreOf([{ idf: 2, posting: { ...t1, st: 'live' } }], 12, now);
    const keptTotal = scoreOf([{ idf: 2, posting: { ...t1, st: 'kept' } }], 12, now);
    expect(liveTotal).toBeGreaterThan(keptTotal);
  });

  it('empty term set scores zero without throwing', () => {
    expect(scoreOf([], 10, 0)).toBe(0);
  });
});
