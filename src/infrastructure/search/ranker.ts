// E5-T01 · BM25-lite ranker (ADR-015: BM25-ish scoring + recency/open-state boosts;
// "ranking constants tunable without schema change" ⇒ all constants ride this block).
// Pure functions over posting entries — the adapter fetches rows, the ranker scores.
export interface PostingEntry {
  /** Doc identity (ledgetab id). */
  readonly id: string;
  /** Term frequency of THIS posting's term in the doc. */
  readonly tf: number;
  /** Doc length in terms (BM25 norm base). */
  readonly dl: number;
  /** Index-side state: live (open) or kept. */
  readonly st: 'live' | 'kept';
  /** Last activity stamp (recency boost). */
  readonly la: number;
}

export const RANK = {
  /** BM25 saturation + length-normalization. */
  K1: 1.2,
  B: 0.75,
  /** Recency boost decay horizon (14 days) + weight. */
  RECENCY_TAU_MS: 1_209_600_000,
  RECENCY_BOOST: 0.25,
  /** Open-state boost weight (a live match is likelier reflex intent). */
  LIVE_BOOST: 0.35,
} as const;

/** Robertson/Sparck-Jones correction term (classic 0.5). */
const IDF_EPSILON = 0.5;

/** BM25 idf (Robertson/Sparck-Jones, +1 form: non-negative over the full df range). */
export const idfOf = (docs: number, df: number): number =>
  Math.log(1 + (docs - df + IDF_EPSILON) / (df + IDF_EPSILON));

/** Single (term, posting) BM25 contribution. avgdl ≤ 0 (degenerate index) degrades to
 *  the doc's own length — totality law: scoring never throws on an empty corpus. */
export const bm25Term = (idf: number, posting: PostingEntry, avgdl: number): number => {
  const normBase = avgdl > 0 ? avgdl : Math.max(1, posting.dl);
  const denom = posting.tf + RANK.K1 * (1 - RANK.B + (RANK.B * posting.dl) / normBase);
  return (idf * (posting.tf * (RANK.K1 + 1))) / denom;
};

/** Recency + open-state multiplicative boost (≥1 — boosts never flip a ranking sign). */
export const boostOf = (posting: PostingEntry, now: number): number => {
  const age = Math.max(0, now - posting.la);
  const recency = RANK.RECENCY_BOOST * Math.exp(-age / RANK.RECENCY_TAU_MS);
  const live = posting.st === 'live' ? RANK.LIVE_BOOST : 0;
  return 1 + recency + live;
};

/** Final score: Σ term BM25 × boost. */
export const scoreOf = (
  perTerm: readonly { readonly idf: number; readonly posting: PostingEntry }[],
  avgdl: number,
  now: number,
): number => {
  let sum = 0;
  let live = false;
  let la = 0;
  let dl = 0;
  for (const t of perTerm) {
    sum += bm25Term(t.idf, t.posting, avgdl);
    live ||= t.posting.st === 'live';
    la = Math.max(la, t.posting.la);
    dl = Math.max(dl, t.posting.dl);
  }
  const representative: PostingEntry = {
    id: perTerm[0]?.posting.id ?? '',
    tf: 1,
    dl,
    st: live ? 'live' : 'kept',
    la,
  };
  return sum * boostOf(representative, now);
};
