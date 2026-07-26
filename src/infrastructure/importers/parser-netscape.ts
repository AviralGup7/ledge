// E5-T05 · parser-netscape-bookmarks (ADR-044). Grammar (corpus-pinned,
// ops/fixtures/import/netscape/**): NETSCAPE-Bookmark-file-1 documents —
// <DL><p> scopes, <DT><H3> folders, <DT><A HREF="…"> links. The parser is a
// tolerant tag token-walker (the SW has no DOM): unclosed tags close at the
// next tag or EOF, a missing prelude is accepted (lenient policy class),
// entities decode in hrefs and titles, ADD_DATE metadata is read-side dropped
// (gap recorded in docs/adr-notes/e5-importers.md — the plan shape has no
// timestamp home yet). Folders ⇒ missions (nested folders are flat sibling
// missions); root-scope links ⇒ the '' loose mission.
import {
  DEADLINE_PROBE_RECORDS,
  deadlineBreached,
  excerptOf,
  verdictUrl,
  type ParseClock,
  type ParseOutcome,
  type ParsedTabDraft,
  type RejectRow,
} from './model.js';

// Quote-aware: an href may itself contain `>` (e.g. a `data:text/html,<h1>…`
// payload) — a naive `<[^>]*>` cut would truncate the tag mid-attribute and
// silently drop the record instead of counting it as a quarantine reject.
const TOKEN = /<(?:"[^"]*"|'[^']*'|[^>"'])+>|[^<]+/g;
// The tokenizer yields ONE TOKEN PER TAG — the corpus's fused `<DT><A HREF=…>`
// arrives as `<DT>` then `<A HREF=…>`, so the grammar anchors per-tag.
const A_OPEN = /^<A(?:\s+HREF=("[^"]*"|'[^']*')[^>]*)?>$/i;
const HREF_ATTR = /HREF=("[^"]*"|'[^']*')/i;
const H3_OPEN = /^<H3(?:\s[^>]*)?>$/i;
const DL_OPEN = /^<DL>(?:<p>)?$/i;
const DL_CLOSE = /^<\/DL>(?:<p>)?$/i;
const DD_OPEN = /^<DD>/i;

/** Decode the five entities the exporters encode (reverse order: &amp; last). */
const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&#39;/g, "'"],
  [/&quot;/g, '"'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&amp;/g, '&'],
];

const decodeEntities = (raw: string): string =>
  ENTITIES.reduce((text, [pattern, withChar]) => text.replace(pattern, withChar), raw);

const collapseWs = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

interface Bucket {
  readonly name: string;
  tabs: ParsedTabDraft[];
}

export const parseNetscape = (text: string, clock: ParseClock): ParseOutcome => {
  const buckets: Bucket[] = [];
  const rejects: RejectRow[] = [];
  const folderStack: number[] = [];
  let loose: Bucket | undefined;
  let pendingName: string | undefined;
  let pendingLink: { href: string; title: string } | undefined;
  let records = 0;
  let halted = false;

  const targetBucket = (): Bucket => {
    const top =
      folderStack.length > 0 ? buckets[folderStack[folderStack.length - 1] ?? -1] : undefined;
    if (top !== undefined) return top;
    if (loose === undefined) {
      loose = { name: '', tabs: [] };
      buckets.push(loose);
    }
    return loose;
  };

  /** A link is final when the tokenizer meets the next tag (or EOF). */
  const commitLink = (): void => {
    if (pendingLink === undefined || halted) {
      pendingLink = undefined;
      return;
    }
    records += 1;
    if (records % DEADLINE_PROBE_RECORDS === 0 && deadlineBreached(clock)) {
      halted = true;
      pendingLink = undefined;
      return;
    }
    const url = decodeEntities(pendingLink.href);
    const verdict = verdictUrl(url);
    if (verdict === 'ok') {
      targetBucket().tabs.push({ url, title: collapseWs(decodeEntities(pendingLink.title)) });
    } else {
      rejects.push({
        ref: `link ${String(records)}`,
        reason: verdict,
        excerpt: excerptOf(url),
      });
    }
    pendingLink = undefined;
  };

  for (const match of text.matchAll(TOKEN)) {
    if (halted) break;
    const token = match[0];
    if (token.startsWith('<')) {
      commitLink(); // tag boundary closes any open link
      if (A_OPEN.test(token) && HREF_ATTR.test(token)) {
        const attr = HREF_ATTR.exec(token)?.[1] ?? '';
        pendingLink = { href: attr.slice(1, attr.length - 1), title: '' };
      } else if (H3_OPEN.test(token)) {
        pendingName = '';
      } else if (DL_OPEN.test(token)) {
        if (pendingName !== undefined && pendingName !== '') {
          buckets.push({ name: pendingName, tabs: [] });
          folderStack.push(buckets.length - 1);
        }
        pendingName = undefined;
      } else if (DL_CLOSE.test(token)) {
        folderStack.pop();
      } else if (DD_OPEN.test(token)) {
        pendingName = undefined; // a description belongs to the previous entry, not a folder
      }
      // All other tags (prelude, TITLE, H1, comments, stray DT) are tolerated noise.
    } else if (pendingLink !== undefined) {
      pendingLink = { href: pendingLink.href, title: pendingLink.title + token };
    } else if (pendingName !== undefined) {
      pendingName = collapseWs(decodeEntities(pendingName + token));
    }
  }
  commitLink();

  return {
    parserId: 'netscape',
    missions: buckets.filter((b) => b.tabs.length > 0),
    rejects,
    records,
    deadlineBreached: halted,
  };
};
