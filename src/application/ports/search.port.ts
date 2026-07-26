// E5-T01 · SearchRankPort — the EES §6 port-row contract for Reflex Search
// ("query(q,scope,limit)→{ids,scores,freshness} · dupesFor(canonHash) · freshness()→lag";
// none-throwing for index shape — correctness > freshness law of §2.11). Implemented in
// infrastructure/search; consumed ONLY by the application query service. The port is the
// seam where the later semantic rank source lands (ADR-015 "additional rank source behind
// the same SearchRankPort") — the query service never knows which answers.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** Wire scope vocabulary (§3 SearchQuery): open=live rows, kept=kept rows,
 *  closed=recently-closed content (sweep-backed in v1 — index carries open/kept). */
export type SearchScope = 'open' | 'kept' | 'closed' | 'all';

/** §2.11 LAG_THRESHOLD: watermark distance past which the query merges a bounded
 *  tail-scan and FLAGS the answer (correctness > freshness; never silent-but-stale). */
export const SEARCH_LAG_THRESHOLD = 2000;

export interface SearchRankHit {
  readonly tabId: string;
  readonly score: number;
  /** Index-side state at projection time: live (open) or kept. */
  readonly state: 'live' | 'kept';
}

export interface SearchRankAnswer {
  readonly hits: readonly SearchRankHit[];
  readonly freshness: 'fresh' | 'lagging';
}

/** Index health as a VALUE (none-throwing law): the application decides the fallback. */
export type SearchRankReply =
  | { readonly kind: 'ok'; readonly answer: SearchRankAnswer }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'absent' | 'dirty' | 'tokenizer-mismatch';
    };

export interface SearchFreshnessReport {
  /** Σ_devices max(0, journal head seq − index watermark seq). */
  readonly lag: number;
  /** Projection-engine dirty flag on the index view (frozen until rebuild). */
  readonly dirty: boolean;
  /** Tokenizer version stamped on the built index (undefined === never built). */
  readonly tokenizerV: number | undefined;
}

export interface SearchRankPort {
  /** Ranked query over the index. 'unavailable' = absent/corrupt/mismatched/dirty —
   *  the caller falls back to the §6.6 bounded sweep and says so. */
  query(input: {
    readonly q: string;
    readonly scope: SearchScope;
    readonly limit: number;
  }): Promise<Result<SearchRankReply, LedgeError>>;
  /** Canonical-hash dupe lookup (E5-T02 marker seam — v1 scans tabs bounded; the
   *  dupe_index family fills this at v1.1 without a port change). */
  dupesFor(input: { readonly canonHash: string }): Promise<Result<readonly string[], LedgeError>>;
  /** Index-lag disclosure (§2.11 "freshness()→lag"). */
  freshness(): Promise<Result<SearchFreshnessReport, LedgeError>>;
  /** Maintenance hook (ADR-015 background reindex): rebuild when the stamped
   *  tokenizerV differs from the shipped one or the view is dirty. SW-chunked via the
   *  projection engine in v1 — the §3.6 offscreen IndexBuildRequest protocol is the
   *  documented 50k-scale door (recorded in the E5 ADR note). */
  ensureIndexFresh(): Promise<void>;
}
