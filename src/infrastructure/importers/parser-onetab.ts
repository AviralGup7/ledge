// E5-T05 · parser-onetab (ADR-044). Grammar (corpus-pinned, ops/fixtures/import/
// onetab/**): one `<url> | <title>` per line, bare-URL lines lawful, blank or
// whitespace-only lines break groups, group ⇒ mission (OneTab exports carry no
// names ⇒ empty-name missions, lawful per covenant §2.2). Tolerates BOM and
// CR/LF/CRLF; quarantines per line, never fatally.
import {
  BOM,
  DEADLINE_PROBE_RECORDS,
  deadlineBreached,
  excerptOf,
  verdictUrl,
  type ParseClock,
  type ParseOutcome,
  type ParsedTabDraft,
  type RejectRow,
} from './model.js';

const LINE_SPLIT = /\r\n|\r|\n/;
const SEPARATOR = ' | ';
const EMPTY_TITLE_SUFFIX = ' |';
const ORPHAN_PREFIX = '|';

export const parseOneTab = (text: string, clock: ParseClock): ParseOutcome => {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const lines = body.split(LINE_SPLIT);
  const missions: { name: string; tabs: ParsedTabDraft[] }[] = [];
  const rejects: RejectRow[] = [];
  let group: ParsedTabDraft[] = [];
  let records = 0;
  let halted = false;

  const closeGroup = (): void => {
    if (group.length > 0) {
      missions.push({ name: '', tabs: group });
      group = [];
    }
  };

  for (let i = 0; i < lines.length && !halted; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) {
      closeGroup();
      continue;
    }
    records += 1;
    if (records % DEADLINE_PROBE_RECORDS === 0 && deadlineBreached(clock)) {
      halted = true;
      break;
    }
    const ref = `line ${String(i + 1)}`;
    if (line.startsWith(ORPHAN_PREFIX)) {
      rejects.push({ ref, reason: 'url-missing', excerpt: excerptOf(line) });
      continue;
    }
    let url = line;
    let title = '';
    const at = line.indexOf(SEPARATOR);
    if (at >= 0) {
      url = line.slice(0, at).trim();
      title = line.slice(at + SEPARATOR.length).trim();
    } else if (line.endsWith(EMPTY_TITLE_SUFFIX)) {
      // Grammar drift class: pipe at end of line = title deliberately empty.
      url = line.slice(0, line.length - EMPTY_TITLE_SUFFIX.length).trim();
    }
    const verdict = verdictUrl(url);
    if (verdict === 'ok') {
      group.push({ url, title });
    } else {
      rejects.push({ ref, reason: verdict, excerpt: excerptOf(line) });
    }
    if (i < lines.length - 1 && (lines[i + 1] ?? '').trim().length === 0) closeGroup();
  }
  closeGroup();

  return { parserId: 'onetab', missions, rejects, records, deadlineBreached: halted };
};
