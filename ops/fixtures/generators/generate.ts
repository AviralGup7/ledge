// E7-T01 · Deterministic synthetic corpus generators (AC: "generators
// deterministic (seeded) for perf harness reuse" — audit A3). One seed, one
// salt per format: same (format, size) ⇒ same bytes on every platform,
// forever. The committed manifest golden (manifest.golden.json) pins the
// checksums; the contract lane re-derives them (ops/tests/contract).
//
// Content law (AC: "corpus licensing/privacy clean"): every URL the
// generators emit lives on an RFC 2606 reserved domain (example.com/org/net);
// titles are composed from the inert word pools below. No real-world host or
// personal data can materialize from this arithmetic.
import { intBelow, mulberry32 } from './prng.js';

/** The corpus family seed (change = a new corpus generation; manifest bump). */
export const CORPUS_SEED = 0x01ed6e51;

/** Size classes named by the roadmap row (tabs/links per file, exactly). */
export const SIZE_CLASSES = [10_000, 50_000, 200_000] as const;
export type CorpusSizeClass = (typeof SIZE_CLASSES)[number];

export const CORPUS_FORMATS = ['onetab', 'sessionbuddy', 'netscape'] as const;
export type CorpusFormat = (typeof CORPUS_FORMATS)[number];

const ONETAB_SALT = 0x9e3779b9;
const SESSIONBUDDY_SALT = 0x85ebca6b;
const NETSCAPE_SALT = 0xc2b2ae35;

const seedFor = (salt: number): number => (CORPUS_SEED ^ salt) >>> 0;

// ---------------------------------------------------------------- content pools
const DOMAINS = ['example.com', 'example.org', 'example.net'] as const; // RFC 2606
const SUBDOMAINS = ['', 'www.', 'docs.', 'blog.', 'archive.'] as const;
const PATH_SEGMENTS = [
  'guide',
  'notes',
  'reference',
  'archive',
  'review',
  'manual',
  'field-notes',
  'index',
  'report',
  'spec',
  'gallery',
  'journal',
] as const;
const WORDS = [
  'ledger',
  'anchor',
  'harbor',
  'signal',
  'meadow',
  'quartz',
  'ember',
  'atlas',
  'cinder',
  'pollen',
  'summit',
  'ripple',
  'tundra',
  'violet',
  'onyx',
  'cedar',
  'bison',
  'falcon',
  'prairie',
  'mosaic',
  'trellis',
  'saffron',
  'juniper',
  'cobalt',
  'magnet',
  'harvest',
  'lantern',
  'compass',
  'willow',
  'granite',
  'zephyr',
  'caldera',
  'danube',
  'estuary',
  'folklore',
  'glacier',
  'hollow',
  'isthmus',
  'kestrel',
  'lagoon',
  'meridian',
  'nectar',
  'outpost',
  'plateau',
  'quiver',
  'rampart',
  'sirocco',
  'topaz',
  'upland',
  'verdant',
  'wharf',
  'yonder',
  'zenith',
  'bramble',
  'chisel',
  'drift',
  'fresco',
  'gable',
  'helix',
  'ingot',
  'kiln',
  'lumen',
  'nimble',
  'osprey',
  'pumice',
  'rowan',
  'thresh',
  'umber',
  'vane',
  'wicket',
  'yew',
  'zinc',
] as const;

const pick = <T>(rng: () => number, pool: readonly T[]): T =>
  pool[intBelow(rng, pool.length)] as T;

const PERCENT_BASE = 100;
const belowPct = (rng: () => number, pct: number): boolean => intBelow(rng, PERCENT_BASE) < pct;

const PATH_ID_BOUND = 90_000;
const QUERY_PCT = 25;

const capitalize = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

const TITLE_MIN_WORDS = 2;
const TITLE_WORD_SPAN = 6; // titles carry 2..7 words

const urlWithOrigin = (rng: () => number): { url: string; origin: string } => {
  const origin = `https://${pick(rng, SUBDOMAINS)}${pick(rng, DOMAINS)}`;
  const path = `${pick(rng, PATH_SEGMENTS)}/${pick(rng, PATH_SEGMENTS)}-${String(
    intBelow(rng, PATH_ID_BOUND),
  )}`;
  const query = belowPct(rng, QUERY_PCT) ? `?q=${pick(rng, WORDS)}` : '';
  return { url: `${origin}/${path}${query}`, origin };
};

const titleAt = (rng: () => number): string => {
  const count = TITLE_MIN_WORDS + intBelow(rng, TITLE_WORD_SPAN);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) words.push(pick(rng, WORDS));
  return [capitalize(words[0] ?? 'entry'), ...words.slice(1)].join(' ');
};

// ------------------------------------------------------------------ OneTab text
// Grammar (grounded 2026-07-26): one `<url> | <title>` per line, bare-URL lines
// lawful, groups separated by a blank line, trailing newline at EOF.
const ONETAB_GROUP_MIN = 2;
const ONETAB_GROUP_SPAN = 13; // groups carry 2..14 tabs
const ONETAB_BARE_PCT = 8;

const oneTabCorpus = (size: number): string => {
  const rng = mulberry32(seedFor(ONETAB_SALT));
  const groups: string[] = [];
  const group: string[] = [];
  let emitted = 0;
  let groupTarget = ONETAB_GROUP_MIN + intBelow(rng, ONETAB_GROUP_SPAN);
  while (emitted < size) {
    const { url } = urlWithOrigin(rng);
    group.push(belowPct(rng, ONETAB_BARE_PCT) ? url : `${url} | ${titleAt(rng)}`);
    emitted += 1;
    if (group.length >= groupTarget && emitted < size) {
      groups.push(group.join('\n'));
      group.length = 0;
      groupTarget = ONETAB_GROUP_MIN + intBelow(rng, ONETAB_GROUP_SPAN);
    }
  }
  groups.push(group.join('\n'));
  return `${groups.join('\n\n')}\n`;
};

// ---------------------------------------------------------- Session Buddy JSON
// Grammar (grounded 2026-07-26, classic v3 export): top-level JSON array of
// session objects { name?, created, generated, modified, windows[] }; window
// { id, top, left, width, height, tabs[] }; tab { id, index, windowId,
// highlighted, active, pinned, status, incognito, audible, mutedInfo, url,
// title, favIconUrl? }. Timestamps are ISO-8601 strings.
const SB_WINDOWS_MIN = 1;
const SB_WINDOWS_SPAN = 3; // 1..3 windows per session
const SB_TABS_MIN = 1;
const SB_TABS_SPAN = 22; // 1..22 tabs per window
const SB_NAMED_PCT = 60;
const SB_PINNED_PCT = 8;
const SB_FAVICON_PCT = 50;
const SB_BASE_EPOCH_MS = 1_700_000_000_000;
const SB_SESSION_GAP_MS = 86_400_000; // one day between sessions
const SB_MODIFY_GAP_MS = 3_600_000; // modified one hour after created
const SB_WINDOW_OFFSET_BOUND = 200;
const SB_WIDTH_BASE = 900;
const SB_WIDTH_SPAN = 800;
const SB_HEIGHT_BASE = 600;
const SB_HEIGHT_SPAN = 500;
const SB_JSON_INDENT = 2;

const sessionBuddyCorpus = (size: number): string => {
  const rng = mulberry32(seedFor(SESSIONBUDDY_SALT));
  const sessions: object[] = [];
  let emitted = 0;
  let sessionOrdinal = 0;
  let tabId = 0;
  while (emitted < size) {
    const created = SB_BASE_EPOCH_MS + sessionOrdinal * SB_SESSION_GAP_MS;
    const windowCount = SB_WINDOWS_MIN + intBelow(rng, SB_WINDOWS_SPAN);
    const windows: object[] = [];
    for (let w = 0; w < windowCount && emitted < size; w += 1) {
      const remaining = size - emitted;
      const wanted = Math.min(SB_TABS_MIN + intBelow(rng, SB_TABS_SPAN), remaining);
      const tabs: object[] = [];
      for (let i = 0; i < wanted; i += 1) {
        const { url, origin } = urlWithOrigin(rng);
        tabs.push({
          id: tabId,
          index: i,
          windowId: w,
          highlighted: false,
          active: i === 0,
          pinned: belowPct(rng, SB_PINNED_PCT),
          status: 'complete',
          incognito: false,
          audible: false,
          mutedInfo: { muted: false },
          url,
          title: titleAt(rng),
          ...(belowPct(rng, SB_FAVICON_PCT) ? { favIconUrl: `${origin}/favicon.ico` } : {}),
        });
        tabId += 1;
        emitted += 1;
      }
      windows.push({
        id: w,
        top: intBelow(rng, SB_WINDOW_OFFSET_BOUND),
        left: intBelow(rng, SB_WINDOW_OFFSET_BOUND),
        width: SB_WIDTH_BASE + intBelow(rng, SB_WIDTH_SPAN),
        height: SB_HEIGHT_BASE + intBelow(rng, SB_HEIGHT_SPAN),
        tabs,
      });
    }
    sessions.push({
      ...(belowPct(rng, SB_NAMED_PCT) ? { name: titleAt(rng) } : {}),
      created: new Date(created).toISOString(),
      generated: new Date(created).toISOString(),
      modified: new Date(created + SB_MODIFY_GAP_MS).toISOString(),
      windows,
    });
    sessionOrdinal += 1;
  }
  return `${JSON.stringify(sessions, null, SB_JSON_INDENT)}\n`;
};

// ------------------------------------------------------------- Netscape HTML
// Grammar (NETSCAPE-Bookmark-file-1): fixed doctype/meta/title/H1 prelude, one
// root <DL><p>; folders are <DT><H3> + nested <DL><p>; links are <DT><A HREF
// ADD_DATE>; every level closes </DL><p>.
const NETSCAPE_PRELUDE = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  '<!-- This is an automatically generated file.',
  '     It will be read and overwritten.',
  '     DO NOT EDIT! -->',
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  '<TITLE>Bookmarks</TITLE>',
  '<H1>Bookmarks</H1>',
  '<DL><p>',
].join('\n');
const NS_FOLDER_MIN = 5;
const NS_FOLDER_SPAN = 21; // folders carry 5..25 links
const NS_LOOSE_PCT = 15; // root-level links outside folders
const NS_NESTED_PCT = 12; // folders carrying one child folder
const NS_BASE_EPOCH_S = 1_700_000_000;
const NS_ADD_DATE_STEP_S = 97;

const netscapeCorpus = (size: number): string => {
  const rng = mulberry32(seedFor(NETSCAPE_SALT));
  const lines: string[] = [NETSCAPE_PRELUDE];
  let emitted = 0;
  let dateOrdinal = 0;
  const addDate = (): number => {
    dateOrdinal += 1;
    return NS_BASE_EPOCH_S + dateOrdinal * NS_ADD_DATE_STEP_S;
  };
  const linkLine = (): string => {
    const { url } = urlWithOrigin(rng);
    emitted += 1;
    return `<DT><A HREF="${url}" ADD_DATE="${String(addDate())}">${titleAt(rng)}</A>`;
  };
  const folder = (depth: number, budget: number): string[] => {
    const out = [`<DT><H3 ADD_DATE="${String(addDate())}">${titleAt(rng)}</H3>`, '<DL><p>'];
    let filled = 0;
    while (filled < budget) {
      if (depth === 0 && belowPct(rng, NS_NESTED_PCT) && budget - filled > NS_FOLDER_MIN) {
        const childBudget = Math.min(NS_FOLDER_MIN + intBelow(rng, NS_FOLDER_SPAN), budget - filled);
        out.push(...folder(depth + 1, childBudget));
        filled += childBudget;
      } else {
        out.push(linkLine());
        filled += 1;
      }
    }
    out.push('</DL><p>');
    return out;
  };
  while (emitted < size) {
    const remaining = size - emitted;
    if (belowPct(rng, NS_LOOSE_PCT) || remaining < NS_FOLDER_MIN) {
      lines.push(linkLine());
    } else {
      const budget = Math.min(NS_FOLDER_MIN + intBelow(rng, NS_FOLDER_SPAN), remaining);
      lines.push(...folder(0, budget));
    }
  }
  lines.push('</DL><p>');
  return `${lines.join('\n')}\n`;
};

/** The one lawful way to produce a synthetic corpus: pure, seeded, exact-count. */
export const generateCorpus = (format: CorpusFormat, size: CorpusSizeClass): string => {
  switch (format) {
    case 'onetab':
      return oneTabCorpus(size);
    case 'sessionbuddy':
      return sessionBuddyCorpus(size);
    case 'netscape':
      return netscapeCorpus(size);
  }
};
