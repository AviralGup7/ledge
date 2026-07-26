// Public surface of infrastructure/search (EES §2.11, E5-T01). The index is a
// projection (deletable/rebuildable); the adapter answers SearchRankPort (EES §6);
// the tokenizer is versioned (drift ⇒ TOKENIZER_V bump ⇒ background reindex).
export { TOKENIZER_V, tokenizeText, tokenizeUrl, tokenizeFields, isCjkChar } from './tokenizer.js';
export { RANK, idfOf, bm25Term, boostOf, scoreOf, type PostingEntry } from './ranker.js';
export {
  searchIndexProjector,
  SEARCH_VIEW,
  SEARCH_STATS_KEY,
  registryKeyOf,
} from './index.projector.js';
export { createSearchRankAdapter, type SearchAdapterDeps } from './search.adapter.js';
