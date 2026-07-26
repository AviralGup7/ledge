// E5-T05 · Importer model — shared parse outcome, quarantine rows, guard law
// (ADR-040: size-capped, chunked, timeout-guarded; EES §2.14: "rejects
// quarantined never fatal"; EES §6 ImporterPort row: E_PARSE_REJECTS(threshold)
// · E_FORMAT_UNKNOWN · E_FILE_GUARD). Parsers are PURE text→outcome functions
// (deterministic: same bytes ⇒ same outcome); the adapter owns transport,
// stash, canon, and commit plans.
//
// Grammar law per parserId (corpus-pinned, ops/fixtures/import/**):
//  - onetab:        `<url> | <title>` lines (bare-URL lines lawful), blank-line
//                   group breaks, BOM/CRLF tolerated;
//  - sessionbuddy:  top-level JSON array of sessions {windows[tabs[url,title]]};
//  - netscape:      NETSCAPE-Bookmark-file-1 tag grammar (<DL>/<DT>/<H3>/<A>),
//                   prelude-less files accepted (lenient policy class).
export const PARSER_IDS = ['onetab', 'sessionbuddy', 'netscape'] as const;
export type ParserId = (typeof PARSER_IDS)[number];

/** Acceptable URL evidence: http/https only (ADR-040 scheme allowlist). */
export const URL_SCHEME_ALLOW = ['https://', 'http://'] as const;

/** One quarantined record (never fatal; the file-level failure rides LedgeError). */
export interface RejectRow {
  /** Where the record lives (line number / json path) — the rejects-file's key. */
  readonly ref: string;
  readonly reason: string;
  /** Truncated evidence (never the whole record — the file can be megabytes). */
  readonly excerpt: string;
}

export interface ParsedTabDraft {
  readonly url: string;
  readonly title: string;
}

export interface ParsedMissionDraft {
  /** '' = the loose/unnamed shelf (empty names are lawful, covenant §2.2). */
  readonly name: string;
  readonly tabs: readonly ParsedTabDraft[];
}

/** What a parser proves about one file (pre-canon; the adapter stamps canon). */
export interface ParseOutcome {
  readonly parserId: ParserId;
  /** Missions with ≥1 surviving tab (zero-tab groupings are dropped). */
  readonly missions: readonly ParsedMissionDraft[];
  readonly rejects: readonly RejectRow[];
  /** Records seen (tabs + rejects) — the E_PARSE_REJECTS majority arithmetic's base. */
  readonly records: number;
  /** Deadline probe fired mid-parse (the adapter promotes this to E_FILE_GUARD
   *  parse-time; a breached outcome is structurally partial and must not ship). */
  readonly deadlineBreached: boolean;
}

// ---- Guard law (EES §6 size/time caps; values are the v1 guards) -------------
/** Byte cap on the decoded file (E_FILE_GUARD size): 32 MiB. Covers onetab 200k
 *  (15.7 MB) and netscape 200k (25.7 MB) corpora; sessionbuddy 200k (107 MB) is
 *  refused-loud by design — the cap refusing exactly that class is the M4
 *  "file-guard caps proven" evidence. */
export const IMPORT_MAX_BYTES = 33_554_432;
/** Wall-clock parse budget (E_FILE_GUARD time) for one preview. */
export const PARSE_DEADLINE_MS = 30_000;
/** Deadline probe cadence inside parser loops (records between clock reads). */
export const DEADLINE_PROBE_RECORDS = 2_000;
/** Reject-excerpt truncation (rejects stay small enough to download). */
export const REJECT_EXCERPT_MAX = 80;
/** E_PARSE_REJECTS majority law: with ≥ MIN records, rejects > records/2 means
 *  the file is garbage wholesale (wrong format), not a good file with bad rows. */
export const REJECT_FATAL_MIN_RECORDS = 16;
export const REJECT_FATAL_MAJOR_DIVISOR = 2;

/** Scheme taxonomy line: has-a-scheme at all (scheme-quarantine) vs bare text
 *  drift where no scheme token exists (url-malformed). */
const SCHEME_SHAPE = /^[a-z][a-z0-9+.-]*:/i;

/** Per-record URL law: WHATWG-parses AND scheme-allowlisted AND token-clean
 *  (a bare `|` or whitespace in the token means the line grammar drifted). */
export type UrlVerdict = 'ok' | 'scheme-quarantine' | 'url-malformed';

export const verdictUrl = (token: string): UrlVerdict => {
  if (token.length === 0 || token.includes('|') || /\s/.test(token)) return 'url-malformed';
  if (!SCHEME_SHAPE.test(token)) return 'url-malformed';
  if (!URL_SCHEME_ALLOW.some((scheme) => token.startsWith(scheme))) return 'scheme-quarantine';
  try {
    const parsed = new URL(token);
    return parsed.hostname.length > 0 ? 'ok' : 'url-malformed';
  } catch {
    return 'url-malformed';
  }
};

/** UTF-8 BOM strip (encoding hostility class; one char, position zero only). */
export const BOM = '﻿';

export const excerptOf = (raw: string, max = REJECT_EXCERPT_MAX): string =>
  raw.length <= max ? raw : `${raw.slice(0, max)}…`;

/** Parse-clock seam: parsers probe the deadline instead of owning timers. */
export interface ParseClock {
  readonly now: () => number;
  readonly deadlineMs: number;
}

export const deadlineBreached = (clock: ParseClock): boolean => clock.now() >= clock.deadlineMs;
