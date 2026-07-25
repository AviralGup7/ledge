// E1-T06 · EES §2.3 / ADR-016 — conservative URL canonicalization (MATCHING ONLY).
// Stored originals are never rewritten; canonForm is derived matching material.
// Laws: idempotent · http/https only (schemeOk:false otherwise) · fragments preserved ·
// denylist-param strips only · never throws (dedupe degrades to exact-match on failure) ·
// trailing-slash normalized on bare path only.
import { CANON_RULES_V1, type CanonRules } from './canon-rules.catalog.js';
import { fnv1a64 } from './fnv1a.js';

export interface CanonResult {
  /** Derived matching form. On failure: the raw input, so dedupe degrades to exact-match. */
  readonly canonForm: string;
  /** fnv1a64(canonForm) — index key only, never an equality oracle. */
  readonly canonHash: string;
  /** Hostname, lowercased+punycode-normalized by the platform URL parser. '' when unknown. */
  readonly domain: string;
  /** false for non-http(s) schemes and unparsable input. */
  readonly schemeOk: boolean;
  /** Rule table version used — provenance for events (canonRulesV). */
  readonly rulesVersion: number;
}

const BARE_PATH = '/';
const EMPTY_DOMAIN = '';

const isDeniedKey = (decodedKeyLower: string, rules: CanonRules): boolean =>
  rules.denyParamPrefixes.some((p) => decodedKeyLower.startsWith(p)) ||
  rules.denyParams.includes(decodedKeyLower);

/** Best-effort lowercase+decode for COMPARISON ONLY (verbatim form is preserved upstream). */
const comparableKey = (rawKey: string): string => {
  try {
    return decodeURIComponent(rawKey).toLowerCase();
  } catch {
    return rawKey.toLowerCase();
  }
};

export function canonicalize(rawUrl: string, rules: CanonRules = CANON_RULES_V1): CanonResult {
  const fallback = (): CanonResult => ({
    canonForm: rawUrl,
    canonHash: fnv1a64(rawUrl),
    domain: EMPTY_DOMAIN,
    schemeOk: false,
    rulesVersion: rules.version,
  });

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fallback();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback();

  // Query: rebuild from the RAW search string, preserving pair order and verbatim text.
  const keptPairs =
    url.search.length > 1
      ? url.search
          .slice(1)
          .split('&')
          .filter((pair) => !isDeniedKey(comparableKey(pair.split('=')[0] ?? ''), rules))
      : [];
  const query = keptPairs.length > 0 ? `?${keptPairs.join('&')}` : '';

  // Trailing-slash normalization on bare path only ("https://ex.com/" → "https://ex.com").
  const path = url.pathname === BARE_PATH ? '' : url.pathname;

  // NOTE: URL.origin DROPS userinfo (golden corpus found this merging https://user:pw@host/a
  // into https://host/a — a conservative-law violation). Rebuild authority with credentials.
  const auth =
    url.username !== '' ? `${url.username}${url.password !== '' ? `:${url.password}` : ''}@` : '';
  // protocol/host fields already carry: lowercase scheme/host, default-port strip, punycode.
  const canonForm = `${url.protocol}//${auth}${url.host}${path}${query}${url.hash}`;
  return {
    canonForm,
    canonHash: fnv1a64(canonForm),
    domain: url.hostname,
    schemeOk: true,
    rulesVersion: rules.version,
  };
}

export const canonHashOf = canonicalize;
