// E5-T01 · Tokenizer v1 (ADR-015: unicode-aware segmentation; full CJK bigram fallback;
// tokenizer version STAMPED on the built index — a drift in this file's semantics is a
// TOKENIZER_V bump, which triggers the background full reindex law of §2.11).
// Hand-rolled by constitutional law (no runtime deps): deterministic across Node/SW.
export const TOKENIZER_V = 1;

/**
 * CJK codepoint ranges (CJK Unified + Extension A, Hiragana, Katakana plus halfwidth,
 * Hangul syllables excluded — Hangul word segmentation rides spaces acceptably at v1).
 */
const CJK = /[⺀-⿟⼀-⿟々-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ﬀ-﮿]/u;

export const isCjkChar = (ch: string): boolean => CJK.test(ch);

const WORD_CHAR = /\p{L}|\p{N}/u;

/** Noise floor: single-char latin/digit runs flood posting rows without recall value. */
const WORD_RUN_MIN = 2;

/**
 * Segment `text` into normalized terms:
 *  - Latin/digit runs (unicode letters+digits): the run, lowercased, length ≥ WORD_RUN_MIN
 *    (single-char runs are noise at BM25-scale and flood the posting rows).
 *  - CJK runs: every overlapping bigram; an isolated CJK char (run of one) becomes a
 *    unigram (a full CJK-bigram fallback must still find single-char tokens).
 * Output order = first-occurrence order (determinism is the determinism-law input).
 */
export const tokenizeText = (text: string): readonly string[] => {
  const out: string[] = [];
  let run = '';
  let cjk: string[] = [];

  const flushRun = (): void => {
    if (run.length >= WORD_RUN_MIN) out.push(run);
    run = '';
  };
  const flushCjk = (): void => {
    if (cjk.length === 1) {
      const solo = cjk[0];
      if (solo !== undefined) out.push(solo);
    } else {
      for (let i = 0; i + 1 < cjk.length; i += 1) {
        const a = cjk[i];
        const b = cjk[i + 1];
        if (a !== undefined && b !== undefined) out.push(`${a}${b}`);
      }
    }
    cjk = [];
  };

  for (const ch of text.toLowerCase()) {
    if (isCjkChar(ch)) {
      flushRun();
      cjk.push(ch);
    } else if (WORD_CHAR.test(ch)) {
      flushCjk();
      run += ch;
    } else {
      flushRun();
      flushCjk();
    }
  }
  flushRun();
  flushCjk();
  return out;
};

/**
 * URL terms: scheme/auth/query-glue are noise — tokenize the visible host+path+query
 * text after dropping the scheme separator (dots/slashes split naturally on WORD_CHAR
 * boundaries; `https://example.com/a-b` → example, com, a, b).
 */
const SCHEME_SEP = '://';

export const tokenizeUrl = (raw: string): readonly string[] => {
  const idx = raw.indexOf(SCHEME_SEP);
  const visible = idx >= 0 ? raw.slice(idx + SCHEME_SEP.length) : raw;
  return tokenizeText(visible);
};

/**
 * Field fusion (title∪url∪domain∪topics), deduped with first-occurrence order —
 * the registry-row entry list of one indexed doc.
 */
export const tokenizeFields = (fields: {
  readonly title: string;
  readonly url?: string | undefined;
  readonly domain?: string | undefined;
  readonly topics?: readonly string[] | undefined;
}): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  const absorb = (terms: readonly string[]): void => {
    for (const t of terms) {
      if (t.length === 0 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  };
  absorb(tokenizeText(fields.title));
  if (fields.domain !== undefined) absorb(tokenizeText(fields.domain));
  if (fields.url !== undefined) absorb(tokenizeUrl(fields.url));
  if (fields.topics !== undefined) {
    for (const topic of fields.topics) absorb(tokenizeText(topic));
  }
  return out;
};
