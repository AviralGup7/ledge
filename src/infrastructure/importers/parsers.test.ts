// E5-T05 · Parser laws — onetab (line grammar, BOM/CRLF tolerance, pipe-inside-
// title, empty/loose groupings), sessionbuddy (structural quarantine levels),
// netscape (tag-walk tolerance, entities, nesting, unclosed edges). Corpus
// acceptance lives in corpus.test.ts; this file pins inline grammar edges.
import { describe, expect, it } from 'vitest';
import { BOM, deadlineBreached, verdictUrl, type ParseClock } from './model.js';
import { parseNetscape } from './parser-netscape.js';
import { parseOneTab } from './parser-onetab.js';
import { parseSessionBuddy } from './parser-sessionbuddy.js';

const CLOCK: ParseClock = { now: () => 1_000, deadlineMs: 2_000 };

describe('E5 verdictUrl · the per-record token law', () => {
  it('accepts http/https only, rejects drifted tokens and hostile schemes', () => {
    expect(verdictUrl('https://example.com/a-1')).toBe('ok');
    expect(verdictUrl('http://example.org/b-2')).toBe('ok');
    expect(verdictUrl('javascript:alert(1)')).toBe('scheme-quarantine');
    expect(verdictUrl('chrome://settings')).toBe('scheme-quarantine');
    expect(verdictUrl('ftp://example.net/x')).toBe('scheme-quarantine');
    expect(verdictUrl('https://example.com/split 1')).toBe('url-malformed');
    expect(verdictUrl('https://example.com/x|y')).toBe('url-malformed');
    expect(verdictUrl('notaurl')).toBe('url-malformed');
    expect(verdictUrl('https://')).toBe('url-malformed');
  });
});

describe('E5 parser-onetab · the line grammar', () => {
  it('strips a leading BOM and tolerates CRLF/CR line endings', () => {
    const text =
      BOM +
      'https://example.com/a | One title\r\n\r\nhttps://example.org/b\rhttps://example.net/c | Third';
    const out = parseOneTab(text, CLOCK);
    // \r splits LINES but not GROUPS (no blank line between b and c): 2 missions.
    expect(out.missions).toHaveLength(2);
    expect(out.missions[0]?.tabs[0]?.title).toBe('One title');
    expect(out.missions[1]?.tabs[0]?.url).toBe('https://example.org/b');
    expect(out.missions[1]?.tabs[1]?.title).toBe('Third');
    expect(out.rejects).toEqual([]);
  });

  it('splits a tight-pipe line at no separator and quarantines the drifted token', () => {
    const out = parseOneTab('https://example.com/a-1|Tight pipe', CLOCK);
    expect(out.missions).toEqual([]);
    expect(out.rejects[0]?.reason).toBe('url-malformed');
  });

  it('keeps pipes inside titles (splits only at the first spaced pipe)', () => {
    const out = parseOneTab('https://example.com/a-1 | Title | with pipe', CLOCK);
    expect(out.missions[0]?.tabs[0]?.title).toBe('Title | with pipe');
    expect(out.rejects).toEqual([]);
  });

  it('drops zero-tab groupings (lawful silence, not empty missions)', () => {
    const out = parseOneTab('https://example.com/a-1\n\n\n\nhttps://example.org/b-2', CLOCK);
    expect(out.missions).toHaveLength(2);
  });

  it('a group of only rejects still counts records (majority arithmetic sees them)', () => {
    const out = parseOneTab('garbage one\ngarbage two\nhttps://example.com/ok-3', CLOCK);
    expect(out.records).toBe(3);
    expect(out.rejects).toHaveLength(2);
    expect(out.missions).toHaveLength(1);
  });
});

describe('E5 parser-sessionbuddy · structural quarantine levels', () => {
  it('json-malformed when the file is not an array (file-level class)', () => {
    const out = parseSessionBuddy('{"not":"an array"}', CLOCK);
    expect(out.records).toBe(0);
    expect(out.rejects[0]?.reason).toBe('json-malformed');
  });

  it('an empty array is a valid zero-session import (never a reject)', () => {
    const out = parseSessionBuddy('[]', CLOCK);
    expect(out.records).toBe(0);
    expect(out.missions).toEqual([]);
    expect(out.rejects).toEqual([]);
  });

  it('windows with no tabs key are window-level quarantine, additive fields tolerated', () => {
    const text = JSON.stringify([
      {
        name: 'Sess',
        windows: [{ id: 0, tabs: [{ url: 'https://example.com/a-1', custom: 'x' }] }, { id: 1 }],
      },
    ]);
    const out = parseSessionBuddy(text, CLOCK);
    expect(out.missions[0]?.name).toBe('Sess');
    expect(out.missions[0]?.tabs).toHaveLength(1);
    expect(out.rejects.map((r) => r.reason)).toEqual(['window-malformed']);
  });

  it('non-string url is a row-level quarantine, never a throw', () => {
    const text = JSON.stringify([
      { windows: [{ tabs: [{ url: 42 }, { url: 'https://example.com/a' }] }] },
    ]);
    const out = parseSessionBuddy(text, CLOCK);
    expect(out.missions[0]?.tabs).toHaveLength(1);
    expect(out.rejects.map((r) => r.ref)).toEqual(['sessions[0].windows[0].tabs[0]']);
  });
});

describe('E5 parser-netscape · the tolerant tag walk', () => {
  it('decodes entities in hrefs and titles (reverse of the exporter encodes)', () => {
    const text =
      '<DL><p>\n<DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1772700000">Amp &amp; &lt;em&gt; &#39;q&#39; &quot;d&quot;</A>\n</DL><p>';
    const out = parseNetscape(text, CLOCK);
    expect(out.missions[0]?.tabs[0]?.url).toBe('https://example.com/a?x=1&y=2');
    expect(out.missions[0]?.tabs[0]?.title).toBe('Amp & <em> \'q\' "d"');
  });

  it('a missing prelude is accepted (lenient policy class)', () => {
    const text = '<DL><p>\n<DT><A HREF="https://example.com/a-1">Loose one</A>\n</DL><p>';
    const out = parseNetscape(text, CLOCK);
    expect(out.missions).toHaveLength(1);
    expect(out.missions[0]?.name).toBe('');
  });

  it('nested folders are flat sibling missions; links attach to the deepest open scope', () => {
    const text =
      '<DL><p>\n<DT><H3>Outer</H3>\n<DL><p>\n<DT><A HREF="https://example.com/o-1">Outer link</A>\n<DT><H3>Inner</H3>\n<DL><p>\n<DT><A HREF="https://example.com/i-1">Inner link</A>\n</DL><p>\n</DL><p>\n</DL><p>';
    const out = parseNetscape(text, CLOCK);
    expect(out.missions.map((m) => m.name)).toEqual(['Outer', 'Inner']);
    expect(out.missions[0]?.tabs[0]?.url).toBe('https://example.com/o-1');
    expect(out.missions[1]?.tabs[0]?.url).toBe('https://example.com/i-1');
  });

  it('unclosed tags close at the next tag or EOF (hostile-unclosed class)', () => {
    const text =
      '<DL><p>\n<DT><A HREF="https://example.com/a-1">never closed\n<DT><A HREF="https://example.com/b-2">second</A>';
    const out = parseNetscape(text, CLOCK);
    expect(out.missions[0]?.tabs).toHaveLength(2);
    expect(out.missions[0]?.tabs[0]?.title).toBe('never closed');
  });

  it('DD descriptions never masquerade as the following folder name', () => {
    const text =
      '<DL><p>\n<DT><A HREF="https://example.com/a-1">Link</A>\n<DD>descr prose\n<DT><H3>Folder</H3>\n<DL><p>\n</DL><p>\n</DL><p>';
    const out = parseNetscape(text, CLOCK);
    // The folder has no links (dropped), the DD must not have renamed anything.
    expect(out.missions).toHaveLength(1);
    expect(out.missions[0]?.name).toBe('');
  });

  it('empty root DL parses to zero missions and zero rejects (edge-valid)', () => {
    const out = parseNetscape('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n</DL><p>', CLOCK);
    expect(out.missions).toEqual([]);
    expect(out.rejects).toEqual([]);
  });
});

describe('E5 parse clocks · the deadline probe', () => {
  it('records beyond the probe cadence halt the parse (outcome marked breached)', () => {
    // Probes fire every 2000 records: first probe sees t=0 (alive), the second
    // at record 4000 sees t=100s (past the 50s deadline) and halts the parse.
    const lines = Array.from({ length: 5000 }, (_, i) => `https://example.com/x-${String(i)}`).join(
      '\n',
    );
    let tick = 0;
    const out = parseOneTab(lines, {
      now: () => {
        tick += 1;
        return tick <= 1 ? 0 : 100_000;
      },
      deadlineMs: 50_000,
    });
    expect(out.deadlineBreached).toBe(true);
    expect(out.records).toBe(4000);
    expect(deadlineBreached({ now: () => 60_000, deadlineMs: 50_000 })).toBe(true);
  });
});
