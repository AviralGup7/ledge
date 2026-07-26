// E5-T01 · SearchRankPort adapter — query/freshness/dupesFor over the 'search_index'
// projection store (EES §6 row; §2.11 law: correctness > freshness, none-throwing for
// index shape — availability is a VALUE and the application owns the fallback).
// v1 corpus law: postings carry open/kept docs only; the 'closed' scope stays
// sweep-backed application-side (index accelerates the corpus that dominates reflex
// search — Spec W6). Tokenizer drift ⇒ 'tokenizer-mismatch' ⇒ app fallback + the
// maintenance lane rebuilds (ensureIndexFresh rides the engine's resumable rebuild).
import type {
  SearchRankPort,
  SearchRankHit,
  SearchRankReply,
} from '@/application/ports/search.port.js';
import { SEARCH_LAG_THRESHOLD } from '@/application/ports/search.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';
import type { StorageEnginePort, StoredRecord } from '@/application/ports/storage-engine.port.js';
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { META_JOURNAL_HEADS_KEY } from '@/infrastructure/journal/index.js';
import type { PostingEntry } from './ranker.js';
import { idfOf, scoreOf } from './ranker.js';
import { SEARCH_STATS_KEY, SEARCH_VIEW } from './index.projector.js';
import { TOKENIZER_V, tokenizeText } from './tokenizer.js';

export interface SearchAdapterDeps {
  readonly engine: StorageEnginePort;
  readonly projections: ProjectionEnginePort;
  readonly now: () => number;
}

interface StatsRow {
  readonly token: string;
  readonly docs: number;
  readonly totalLen: number;
  readonly tokenizerV: number;
}

interface RegistryRow {
  readonly token: string;
  readonly canonHash: string;
}

const REGISTRY_PREFIX = 'tab:';
const REGISTRY_PREFIX_LEN = REGISTRY_PREFIX.length;

const postingsOf = (row: StoredRecord | undefined): readonly PostingEntry[] =>
  row !== undefined && Array.isArray(row['p']) ? (row['p'] as readonly PostingEntry[]) : [];

const stateForScope = (scope: 'open' | 'kept' | 'closed' | 'all'): ReadonlySet<'live' | 'kept'> => {
  if (scope === 'open') return new Set(['live']);
  if (scope === 'kept') return new Set(['kept']);
  if (scope === 'closed') return new Set(); // no indexed corpus — sweep-backed v1 (§2.11 note)
  return new Set(['live', 'kept']);
};

export const createSearchRankAdapter = (deps: SearchAdapterDeps): SearchRankPort => {
  const readStats = async (): Promise<Result<StatsRow | undefined, LedgeError>> =>
    deps.engine.txn(['search_index'], 'readonly', async (tx) => {
      const row = await tx.table<StoredRecord>('search_index').get(SEARCH_STATS_KEY);
      return row === undefined ? undefined : (row as unknown as StatsRow);
    });

  const freshnessRaw = async (): Promise<
    Result<{ readonly lag: number; readonly dirty: boolean }, LedgeError>
  > => {
    const status = await deps.projections.status();
    if (!status.ok) return { ok: false, error: status.error };
    const view = status.value.views.find((v) => v.view === SEARCH_VIEW);
    const dirty = view?.dirty ?? false;
    const headsR = await deps.engine.txn(['meta'], 'readonly', (tx) =>
      tx
        .table<{ readonly key: string; readonly value: unknown }>('meta')
        .get(META_JOURNAL_HEADS_KEY),
    );
    if (!headsR.ok) return { ok: false, error: headsR.error };
    const heads = (headsR.value?.value ?? {}) as Record<string, { readonly lastSeq?: unknown }>;
    let lag = 0;
    for (const [deviceId, head] of Object.entries(heads)) {
      const headSeq = typeof head.lastSeq === 'number' ? head.lastSeq : 0;
      const wm = view?.watermarks.find((w) => (w.deviceId as string) === deviceId)?.seq ?? 0;
      lag += Math.max(0, headSeq - wm);
    }
    return { ok: true, value: { lag, dirty } };
  };

  const query: SearchRankPort['query'] = async (input) => {
    const terms = tokenizeText(input.q);
    const statsR = await readStats();
    if (!statsR.ok) return { ok: false, error: statsR.error };
    const stats = statsR.value;
    const freshR = await freshnessRaw();
    if (!freshR.ok) return { ok: false, error: freshR.error };
    const freshness: 'fresh' | 'lagging' =
      freshR.value.lag > SEARCH_LAG_THRESHOLD ? 'lagging' : 'fresh';
    if (stats === undefined) {
      const none: SearchRankReply = { kind: 'unavailable', reason: 'absent' };
      return ok(none);
    }
    if (freshR.value.dirty) {
      const none: SearchRankReply = { kind: 'unavailable', reason: 'dirty' };
      return ok(none);
    }
    if (stats.tokenizerV !== TOKENIZER_V) {
      const none: SearchRankReply = { kind: 'unavailable', reason: 'tokenizer-mismatch' };
      return ok(none);
    }
    if (terms.length === 0) {
      const none: SearchRankReply = {
        kind: 'ok',
        answer: { hits: [], freshness },
      };
      return ok(none);
    }
    const scopeStates = stateForScope(input.scope);
    const rowsR = await deps.engine.txn(['search_index'], 'readonly', async (tx) => {
      const table = tx.table<StoredRecord>('search_index');
      const rows: (StoredRecord | undefined)[] = [];
      for (const t of terms) rows.push(await table.get(t));
      return rows;
    });
    if (!rowsR.ok) return { ok: false, error: rowsR.error };

    // AND totality (mirrors the sweep's every-term law): any missing term ⇒ no hits.
    const perTerm = rowsR.value.map(postingsOf);
    const scores = new Map<string, { score: number; st: 'live' | 'kept' }>();
    const avgdl = stats.docs > 0 ? stats.totalLen / stats.docs : 0;
    const idfs = perTerm.map((p) => idfOf(stats.docs, p.length));
    const firstTerm = perTerm[0];
    if (firstTerm === undefined) {
      const none: SearchRankReply = { kind: 'ok', answer: { hits: [], freshness } };
      return ok(none);
    }
    for (const posting of firstTerm) {
      if (!scopeStates.has(posting.st)) continue;
      const matched: { readonly idf: number; readonly posting: PostingEntry }[] = [];
      const firstIdf = idfs[0];
      if (firstIdf !== undefined) matched.push({ idf: firstIdf, posting });
      let missing = false;
      for (let i = 1; i < perTerm.length; i += 1) {
        const found = (perTerm[i] ?? []).find((p) => p.id === posting.id);
        const idf = idfs[i];
        if (found === undefined || idf === undefined) {
          missing = true;
          break;
        }
        matched.push({ idf, posting: found });
      }
      if (missing) continue;
      const score = scoreOf(matched, avgdl, deps.now());
      const prior = scores.get(posting.id);
      if (prior === undefined || score > prior.score) {
        scores.set(posting.id, { score, st: posting.st });
      }
    }
    const hits: SearchRankHit[] = [...scores.entries()]
      .map(([tabId, v]) => ({ tabId, score: v.score, state: v.st }))
      .sort((a, b) => b.score - a.score || (a.tabId < b.tabId ? -1 : 1))
      .slice(0, input.limit);
    const reply: SearchRankReply = {
      kind: 'ok',
      answer: { hits, freshness },
    };
    return ok(reply);
  };

  const dupesFor: SearchRankPort['dupesFor'] = async (input) => {
    // v1 bounded registry scan (corpus-bounded @10k; the dupe_index family accelerates
    // this at v1.1 without a port change — E5-T02 is roadmap-deferred by design).
    const rowsR = await deps.engine.txn(['search_index'], 'readonly', (tx) =>
      tx.table<StoredRecord>('search_index').toArray(),
    );
    if (!rowsR.ok) return rowsR;
    const ids: string[] = [];
    for (const row of rowsR.value) {
      const key = row['token'];
      if (typeof key !== 'string' || !key.startsWith(REGISTRY_PREFIX)) continue;
      if ((row as unknown as RegistryRow).canonHash === input.canonHash) {
        ids.push(key.slice(REGISTRY_PREFIX_LEN));
      }
    }
    return ok(ids);
  };

  const freshness: SearchRankPort['freshness'] = async () => {
    const statsR = await readStats();
    if (!statsR.ok) return { ok: false, error: statsR.error };
    const freshR = await freshnessRaw();
    if (!freshR.ok) return { ok: false, error: freshR.error };
    return ok({
      lag: freshR.value.lag,
      dirty: freshR.value.dirty,
      tokenizerV: statsR.value?.tokenizerV,
    });
  };

  const ensureIndexFresh = async (): Promise<void> => {
    const f = await freshness();
    if (!f.ok) return; // maintenance is best-effort; queries stay honest via fallback
    if (f.value.dirty || f.value.tokenizerV !== TOKENIZER_V) {
      await deps.projections.rebuild(SEARCH_VIEW); // engine law: chunked + resumable
    }
  };

  return { query, dupesFor, freshness, ensureIndexFresh };
};
