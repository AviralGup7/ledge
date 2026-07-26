// E5-T05 · Format detection (EES §6 ImporterPort row: detect(fileMeta)→parserId,
// folded into preview by the frozen C20 contract). Content-primary: the file's
// own grammar decides, never its extension (hostile honesty — a .json name can
// lie). First-line-anchored for the line grammar, array-anchored for JSON,
// tag-anchored for the bookmark family; parserHint overrides when valid.
import { BOM, PARSER_IDS, type ParserId } from './model.js';

/** Detection looks at the head only (files may be 32 MB; detection is O(1)). */
export const SNIFF_HEAD_CHARS = 512;

const JSON_ARRAY_ANCHOR = /^\s*\[/;
const NETSCAPE_TAG_ANCHOR = /<DT><A\s/i;
const NETSCAPE_DOCTYPE_ANCHOR = /NETSCAPE-Bookmark-file-1/i;
// Multi-line: hostile onetab files may front-load rejected-scheme lines
// (e.g. `javascript:…`) before the first importable URL; any head line
// starting with http(s) anchors the line grammar. JSON rows stay safe —
// their URLs are quote-anchored mid-line, never at line start.
const ONETAB_URL_ANCHOR = /^\s*https?:\/\//m;

export const sniffParser = (
  head: string,
  hint?: string | undefined,
): { ok: true; parserId: ParserId } | { ok: false; reason: 'hint-invalid' | 'detect-failed' } => {
  if (hint !== undefined) {
    const found = (PARSER_IDS as readonly string[]).includes(hint);
    return found ? { ok: true, parserId: hint as ParserId } : { ok: false, reason: 'hint-invalid' };
  }
  const probe = head.startsWith(BOM) ? head.slice(BOM.length) : head;
  if (JSON_ARRAY_ANCHOR.test(probe)) return { ok: true, parserId: 'sessionbuddy' };
  if (NETSCAPE_DOCTYPE_ANCHOR.test(probe) || NETSCAPE_TAG_ANCHOR.test(probe))
    return { ok: true, parserId: 'netscape' };
  if (ONETAB_URL_ANCHOR.test(probe)) return { ok: true, parserId: 'onetab' };
  return { ok: false, reason: 'detect-failed' };
};
