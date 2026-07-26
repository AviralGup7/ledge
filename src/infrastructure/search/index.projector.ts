// E5-T01 · Search-index projector — the §2.11 "index is a projection (deletable/
// rebuildable)" machine. It maintains THREE row families inside the 'search_index'
// store (plain pk 'token'), deriving ONLY from journal events + prior store state:
//   1. TERM rows      {token, p: PostingEntry[]}                  — the inverted index.
//   2. REGISTRY rows  {token:'tab:<id>', title,url,domain,terms,dl,st,la,canonHash}
//      — one per indexed tab; retained THROUGH trash (postings drop, registry survives)
//      so TrashRestored re-materializes postings without reading other stores
//      (projector read-law: own store only).
//   3. STATS row      {token:'meta:stats', docs,totalLen,tokenizerV} — BM25 globals +
//      the tokenizerV stamp the availability law reads (§2.11 versioning).
// State assignment MIRRORS the tabs-store projector (the projector of record): KEPT
// stamps only on TabAssigned (never MissionFormed); only LIVE rows die on
// TabClosedExternal; trash is never searchable; purge removes the registry too. Every
// path is upsert-idempotent, and a derived no-change returns ZERO ops (watermark-edge
// replays emit nothing, frames stay minimal).
import type { DeltaOp, ProjectorDef } from '@/application/ports/projection-engine.port.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';
import type { PostingEntry } from './ranker.js';
import { TOKENIZER_V, tokenizeFields } from './tokenizer.js';

export const SEARCH_VIEW = 'searchIndex';
export const SEARCH_STATS_KEY = 'meta:stats';
const REGISTRY_PREFIX = 'tab:';

export const registryKeyOf = (tabId: string): string => `${REGISTRY_PREFIX}${tabId}`;

export interface RegistryRow {
  readonly token: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly terms: readonly { readonly t: string; readonly tf: number }[];
  readonly dl: number;
  readonly st: 'live' | 'kept' | 'trash';
  readonly la: number;
  readonly canonHash: string;
}

interface StatsRow {
  readonly token: string;
  readonly docs: number;
  readonly totalLen: number;
  readonly tokenizerV: number;
}

type Read = (key: string) => Promise<StoredRecord | undefined>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

const asRegistry = (row: StoredRecord | undefined): RegistryRow | undefined =>
  row === undefined ? undefined : (row as unknown as RegistryRow);

const EMPTY_STATS: StatsRow = {
  token: SEARCH_STATS_KEY,
  docs: 0,
  totalLen: 0,
  tokenizerV: TOKENIZER_V,
};

const asStats = (row: StoredRecord | undefined): StatsRow =>
  row === undefined ? EMPTY_STATS : (row as unknown as StatsRow);

/** Doc term multiset: tokenizeFields supplies first-occurrence order; tf counts repeats. */
const termsOf = (
  title: string,
  url: string,
  domain: string,
): {
  readonly terms: readonly { readonly t: string; readonly tf: number }[];
  readonly dl: number;
} => {
  const counts = new Map<string, number>();
  for (const t of tokenizeFields({ title, url, domain })) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let dl = 0;
  const terms: { readonly t: string; readonly tf: number }[] = [];
  for (const [t, tf] of counts) {
    terms.push({ t, tf });
    dl += tf;
  }
  return { terms, dl };
};

const sameTerms = (
  a: readonly { readonly t: string; readonly tf: number }[],
  b: readonly { readonly t: string; readonly tf: number }[],
): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return y !== undefined && y.t === x.t && y.tf === x.tf;
  });

const isSearchable = (r: RegistryRow | undefined): r is RegistryRow =>
  r !== undefined && r.st !== 'trash';

const postingsOf = (row: StoredRecord | undefined): readonly PostingEntry[] =>
  Array.isArray(row?.['p']) ? (row['p'] as readonly PostingEntry[]) : [];

/** Diff prior → next registry content into store ops (term rows + registry + stats). */
const diffOps = async (
  read: Read,
  tabId: string,
  prior: RegistryRow | undefined,
  next: RegistryRow | undefined,
): Promise<readonly DeltaOp[]> => {
  if (prior === undefined && next === undefined) return [];
  const unchanged =
    prior !== undefined &&
    next !== undefined &&
    prior.st === next.st &&
    prior.la === next.la &&
    prior.dl === next.dl &&
    prior.title === next.title &&
    prior.url === next.url &&
    prior.domain === next.domain &&
    prior.canonHash === next.canonHash &&
    sameTerms(prior.terms, next.terms);
  if (unchanged) return []; // zero-op law

  const ops: DeltaOp[] = [];
  const names = new Set<string>();
  if (isSearchable(prior)) for (const e of prior.terms) names.add(e.t);
  if (isSearchable(next)) for (const e of next.terms) names.add(e.t);

  for (const name of names) {
    const row = await read(name);
    const keep = postingsOf(row).filter((p) => p.id !== tabId);
    const nextTerm = isSearchable(next) ? next.terms.find((e) => e.t === name) : undefined;
    const nextEntry =
      nextTerm !== undefined && isSearchable(next)
        ? { id: tabId, tf: nextTerm.tf, dl: next.dl, st: next.st as 'live' | 'kept', la: next.la }
        : undefined;
    if (nextEntry === undefined) {
      if (keep.length !== postingsOf(row).length || row !== undefined) {
        if (keep.length === 0) ops.push({ kind: 'remove', key: name });
        else ops.push({ kind: 'upsert', key: name, record: { token: name, p: keep } });
      }
      continue;
    }
    const before = postingsOf(row).find((p) => p.id === tabId);
    const changed =
      before === undefined ||
      before.tf !== nextEntry.tf ||
      before.dl !== nextEntry.dl ||
      before.st !== nextEntry.st ||
      before.la !== nextEntry.la;
    if (!changed) continue;
    ops.push({
      kind: 'upsert',
      key: name,
      record: { token: name, p: [...keep, nextEntry] },
    });
  }

  if (next !== undefined) {
    ops.push({ kind: 'upsert', key: next.token, record: next as unknown as StoredRecord });
  } else if (prior !== undefined) {
    ops.push({ kind: 'remove', key: prior.token });
  }

  // Stats row: only the SEARCHABLE population counts toward BM25 globals.
  const stats = asStats(await read(SEARCH_STATS_KEY));
  let docs = stats.docs;
  let totalLen = stats.totalLen;
  if (isSearchable(prior)) {
    docs -= 1;
    totalLen -= prior.dl;
  }
  if (isSearchable(next)) {
    docs += 1;
    totalLen += next.dl;
  }
  docs = Math.max(0, docs);
  totalLen = Math.max(0, totalLen);
  if (docs !== stats.docs || totalLen !== stats.totalLen || stats.tokenizerV !== TOKENIZER_V) {
    const stamped: StatsRow = {
      token: SEARCH_STATS_KEY,
      docs,
      totalLen,
      tokenizerV: TOKENIZER_V,
    };
    ops.push({
      kind: 'upsert',
      key: SEARCH_STATS_KEY,
      record: stamped as unknown as StoredRecord,
    });
  }
  return ops;
};

/** Doc facts from payload (TabObserved / ImportCommitted rows share the field shape). */
const docFrom = (p: Readonly<Record<string, unknown>>, wall: number): Partial<RegistryRow> => ({
  title: str(p['title']),
  url: str(p['url']),
  domain: str(p['domain']),
  la: numOr(p['ts'], wall),
  canonHash: canonicalize(str(p['url'])).canonHash,
});

const buildNext = (
  key: string,
  fields: {
    readonly title: string;
    readonly url: string;
    readonly domain: string;
    readonly st: RegistryRow['st'];
    readonly la: number;
    readonly canonHash: string;
  },
): RegistryRow => {
  const { terms, dl } = termsOf(fields.title, fields.url, fields.domain);
  return {
    token: key,
    title: fields.title,
    url: fields.url,
    domain: fields.domain,
    terms,
    dl,
    st: fields.st,
    la: fields.la,
    canonHash: fields.canonHash,
  };
};

const project = async (event: EventEnvelope, read: Read): Promise<readonly DeltaOp[]> => {
  const p = event.payload as Record<string, unknown>;
  const wall = event.hlc.wallClock;

  switch (event.type) {
    case 'TabObserved': {
      const id = str(p['ledgeTabId']);
      if (id.length === 0) return [];
      const f = docFrom(p, wall);
      const next = buildNext(registryKeyOf(id), {
        title: str(f.title),
        url: str(f.url),
        domain: str(f.domain),
        st: 'live',
        la: numOr(f.la, wall),
        canonHash: str(f.canonHash),
      });
      return diffOps(read, id, asRegistry(await read(registryKeyOf(id))), next);
    }
    case 'TabUpdated': {
      const id = str(p['ledgeTabId']);
      if (id.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      if (prior === undefined) return []; // mirrors tabs law: patch-on-missing is a no-op
      const changes =
        typeof p['changes'] === 'object' && p['changes'] !== null
          ? (p['changes'] as Record<string, unknown>)
          : {};
      const urlChanged = typeof changes['url'] === 'string';
      const url = urlChanged && typeof changes['url'] === 'string' ? changes['url'] : prior.url;
      const domain =
        typeof changes['domain'] === 'string'
          ? changes['domain']
          : urlChanged
            ? canonicalize(url).domain
            : prior.domain;
      const canonHash = urlChanged ? canonicalize(url).canonHash : prior.canonHash;
      const next = buildNext(prior.token, {
        title: typeof changes['title'] === 'string' ? changes['title'] : prior.title,
        url,
        domain,
        st: prior.st,
        la: wall,
        canonHash,
      });
      return diffOps(read, id, prior, next);
    }
    case 'TabActivatedObserved': {
      const id = str(p['ledgeTabId']);
      if (id.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      if (prior === undefined) return [];
      const la = numOr(p['ts'], wall);
      if (la === prior.la) return [];
      return diffOps(read, id, prior, { ...prior, la });
    }
    case 'TabAssigned': {
      const id = str(p['tabId']);
      const missionId = str(p['missionId']);
      if (id.length === 0 || missionId.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      if (prior === undefined || prior.st !== 'live') return [];
      return diffOps(read, id, prior, { ...prior, st: 'kept', la: wall });
    }
    case 'TabClosedExternal': {
      const id = str(p['ledgeTabId']);
      if (id.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      // Finality mirror: only LIVE-indexed docs die on a close observation.
      if (!isSearchable(prior) || prior.st !== 'live') return [];
      return diffOps(read, id, prior, undefined);
    }
    case 'EntityTrashed': {
      if (str(p['kind']) !== 'tab') return [];
      const id = str(p['id']);
      if (id.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      if (!isSearchable(prior)) return [];
      // Postings drop; the registry SURVIVES trash (restore must not need other stores).
      return diffOps(read, id, prior, { ...prior, st: 'trash' });
    }
    case 'TrashRestored': {
      if (str(p['kind']) !== 'tab') return [];
      const id = str(p['id']);
      if (id.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      if (prior === undefined || prior.st !== 'trash') return [];
      return diffOps(read, id, prior, { ...prior, st: 'kept', la: wall });
    }
    case 'TrashPurged': {
      if (str(p['kind']) !== 'tab') return [];
      const id = str(p['id']);
      if (id.length === 0) return [];
      const prior = asRegistry(await read(registryKeyOf(id)));
      if (prior === undefined) return [];
      // Purge removes the registry too (view purge mirrors journal law); a searchable
      // doc purged without a trash step still balances the stats row via the diff.
      return diffOps(read, id, prior, undefined);
    }
    case 'MissionResumed': {
      const mapping =
        typeof p['restoredMapping'] === 'object' && p['restoredMapping'] !== null
          ? (p['restoredMapping'] as Record<string, unknown>)
          : undefined;
      const tabs = Array.isArray(mapping?.['tabs']) ? (mapping['tabs'] as unknown[]) : [];
      let out: readonly DeltaOp[] = [];
      for (const t of tabs) {
        if (typeof t !== 'object' || t === null) continue;
        const id = str((t as Record<string, unknown>)['tabId']);
        if (id.length === 0) continue;
        const prior = asRegistry(await read(registryKeyOf(id)));
        if (prior === undefined || prior.st !== 'kept') continue;
        out = [...out, ...(await diffOps(read, id, prior, { ...prior, st: 'live', la: wall }))];
      }
      return out;
    }
    case 'ImportCommitted': {
      const manifest =
        typeof p['batchManifestRef'] === 'object' && p['batchManifestRef'] !== null
          ? (p['batchManifestRef'] as Record<string, unknown>)
          : undefined;
      const list = Array.isArray(manifest?.['missions']) ? (manifest['missions'] as unknown[]) : [];
      let out: readonly DeltaOp[] = [];
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const tabs = (item as Record<string, unknown>)['tabs'];
        if (!Array.isArray(tabs)) continue;
        for (const t of tabs) {
          if (typeof t !== 'object' || t === null) continue;
          const tr = t as Record<string, unknown>;
          const id = str(tr['ledgeTabId']);
          if (id.length === 0) continue;
          const f = docFrom(tr, wall);
          const next = buildNext(registryKeyOf(id), {
            title: str(f.title),
            url: str(f.url),
            domain: str(f.domain),
            st: 'kept',
            la: wall,
            canonHash:
              typeof tr['urlCanonHash'] === 'string' ? tr['urlCanonHash'] : str(f.canonHash),
          });
          out = [
            ...out,
            ...(await diffOps(read, id, asRegistry(await read(registryKeyOf(id))), next)),
          ];
        }
      }
      return out;
    }
    default:
      return [];
  }
};

/** The §2.11 index projector (registry growth law: store declared, pk declared; engine
 *  core untouched). */
export const searchIndexProjector: ProjectorDef = {
  view: SEARCH_VIEW,
  store: 'search_index',
  keyField: 'token',
  projectorV: 1,
  project,
};
