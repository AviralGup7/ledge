// E5-T05 · Corpus acceptance — the E7-T01 fixture corpus is the parsers'
// acceptance set (M4 precondition met: corpus-first). Every committed corpus
// file maps to its expected verdict here; the census runs BOTH WAYS so a new
// corpus file without an expectation (or a dropped file) fails loud. Classes
// and row counts derive only from the file bytes + the shipped adapter.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createIdGenerator, type IdGenerator, type Now } from '@/shared-kernel/identity/index.js';
import { createImportersAdapter, type ImportersAdapter } from './importers.adapter.js';
import type { ParserId } from './model.js';

const FIXTURES = fileURLToPath(new URL('../../../ops/fixtures/import', import.meta.url));

/** Deterministic ids/now (parsing law must not depend on wall time). */
const makeIds = (): IdGenerator =>
  createIdGenerator({
    now: () => 1_000,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  });
const NOW: Now = () => 1_785_024_000_000;

const makeAdapter = (): ImportersAdapter => createImportersAdapter({ ids: makeIds(), now: NOW });

const previewText = (adapter: ImportersAdapter, rel: string) =>
  adapter.preview({
    fileMeta: { name: rel.split('/').pop() ?? rel, size: 0 },
    bytesRef: { kind: 'text', text: readFileSync(`${FIXTURES}/${rel}`, 'utf8') },
  });

interface Expectation {
  readonly parserId: ParserId;
  readonly missions: number;
  readonly tabs: number;
  readonly rejects: number;
  readonly dupes: number;
  readonly note: string;
}

const EXPECT_BASIC: Readonly<Record<string, Expectation>> = {
  'onetab/basic.txt': {
    parserId: 'onetab',
    missions: 2,
    tabs: 8,
    rejects: 0,
    dupes: 0,
    note: 'titled + bare lines, one group break',
  },
  'sessionbuddy/basic.json': {
    parserId: 'sessionbuddy',
    missions: 2,
    tabs: 7,
    rejects: 0,
    dupes: 0,
    note: 'named + unnamed sessions, pinned, empty title lawful',
  },
  'netscape/basic.html': {
    parserId: 'netscape',
    missions: 4, // loose shelf + Reading anchor + Field quartz + Nested ember
    tabs: 7,
    rejects: 0,
    dupes: 0,
    note: 'prelude, folders, one nesting, DD description never a tab',
  },
};

const EXPECT_HOSTILE: Readonly<Record<string, Expectation>> = {
  'onetab/hostile-crlf-blank-noise.txt': {
    parserId: 'onetab',
    missions: 3,
    tabs: 4, // anchor + quartz + ember (bare url) + atlas
    rejects: 1, // the tight-pipe line
    dupes: 0,
    note: 'CRLF, whitespace separators, stray blanks all tolerated',
  },
  'onetab/hostile-mega-line.txt': {
    parserId: 'onetab',
    missions: 1,
    tabs: 2,
    rejects: 0,
    dupes: 0,
    note: '4KB title line parses (file-level guard is a separate class)',
  },
  'onetab/hostile-schemes-malformed.txt': {
    parserId: 'onetab',
    missions: 1,
    tabs: 2, // the duplicate pair: both parse, one is a dupe
    rejects: 7, // js/data/chrome/ftp quarantine + notaurl + space-in-path + fragment-only
    dupes: 1,
    note: 'scheme quarantine + malformed tokens + dupes, in one flat group',
  },
  'onetab/hostile-separator-drift.txt': {
    parserId: 'onetab',
    missions: 1,
    tabs: 3, // bare url, `url |` empty title, title-containing-pipe
    rejects: 3, // orphan title, plain-text note, tight pipe
    dupes: 0,
    note: 'separator drift policy pinned per line',
  },
  'onetab/hostile-unicode-bom.txt': {
    parserId: 'onetab',
    missions: 1,
    tabs: 5,
    rejects: 0,
    dupes: 0,
    note: 'BOM, NUL-q-free unicode accents/CJK/RTL/ZWJ survive intact',
  },
  'sessionbuddy/hostile-empty-array.json': {
    parserId: 'sessionbuddy',
    missions: 0,
    tabs: 0,
    rejects: 0,
    dupes: 0,
    note: '[] parses to a zero-session import (edge-valid)',
  },
  'sessionbuddy/hostile-missing-url-additive.json': {
    parserId: 'sessionbuddy',
    missions: 1,
    tabs: 1, // the additive-fields tab survives
    rejects: 3, // missing url + empty url + tabs-less window
    dupes: 0,
    note: 'row/window quarantine; additive fields tolerated, never carried',
  },
  'sessionbuddy/hostile-wrong-types.json': {
    parserId: 'sessionbuddy',
    missions: 1,
    tabs: 1, // the clean tab in the third session
    rejects: 4, // windows-as-object + string session + numeric url + null tabs
    dupes: 0,
    note: 'schema drift quarantines at its own structural level',
  },
  'netscape/hostile-dupes.html': {
    parserId: 'netscape',
    missions: 3,
    tabs: 5,
    rejects: 0,
    dupes: 2, // dup-4242 ×2 beyond first, quartz-771 ×1 beyond first
    note: 'cross-folder HREF repeats ride the dupe arithmetic',
  },
  'netscape/hostile-empty-dl.html': {
    parserId: 'netscape',
    missions: 0,
    tabs: 0,
    rejects: 0,
    dupes: 0,
    note: 'prelude with empty root DL (edge-valid)',
  },
  'netscape/hostile-entities-crlf.html': {
    parserId: 'netscape',
    missions: 1, // all links root-scope (no folders)
    tabs: 5,
    rejects: 0,
    dupes: 0,
    note: 'entities decode; percent-encoded path rides through unchanged',
  },
  'netscape/hostile-no-doctype.html': {
    parserId: 'netscape',
    missions: 2, // loose shelf + the one folder
    tabs: 3,
    rejects: 0,
    dupes: 0,
    note: 'bare <DL> accepted (lenient policy class)',
  },
  'netscape/hostile-schemes.html': {
    parserId: 'netscape',
    missions: 1,
    tabs: 1, // the one clean bookmark
    rejects: 7, // chrome/js/data/file/place/about/view-source
    dupes: 0,
    note: 'scheme quarantine from the HREF attribute alone',
  },
  'netscape/hostile-unclosed.html': {
    parserId: 'netscape',
    missions: 3, // loose + folder + child (unclosed DLs still hold their links)
    tabs: 3,
    rejects: 0,
    dupes: 0,
    note: 'unclosed tags close at the next tag / EOF',
  },
};

/** Corpus files whose class is a FILE-LEVEL error (never a partial preview). */
const EXPECT_FATAL: Readonly<Record<string, { code: string; note: string }>> = {
  'sessionbuddy/hostile-truncated.json': {
    code: 'E_FORMAT_UNKNOWN',
    note: 'JSON cut mid-string — detected sb, strict parse refuses',
  },
  'sessionbuddy/hostile-stray-prefix.json': {
    code: 'E_FORMAT_UNKNOWN',
    note: 'stray byte before the array — detection fails loud',
  },
};

const corpusFiles = (): string[] =>
  ['onetab', 'sessionbuddy', 'netscape'].flatMap((dir) =>
    readdirSync(`${FIXTURES}/${dir}`)
      .filter((f) => !f.startsWith('.'))
      .map((f) => `${dir}/${f}`),
  );

describe('E5-T05 corpus acceptance · basics parse clean', () => {
  for (const [rel, exp] of Object.entries(EXPECT_BASIC)) {
    it(`${rel} → ${exp.note}`, async () => {
      const preview = await previewText(makeAdapter(), rel);
      expect(preview.ok, JSON.stringify(preview)).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.parserId).toBe(exp.parserId);
      expect(preview.value.missions).toBe(exp.missions);
      expect(preview.value.tabs).toBe(exp.tabs);
      expect(preview.value.rejects).toBe(exp.rejects);
      expect(preview.value.dupesHint).toBe(exp.dupes);
    });
  }
});

describe('E5-T05 corpus acceptance · hostile classes quarantine, never fatal', () => {
  for (const [rel, exp] of Object.entries(EXPECT_HOSTILE)) {
    it(`${rel} → ${exp.note}`, async () => {
      const preview = await previewText(makeAdapter(), rel);
      expect(preview.ok, JSON.stringify(preview)).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.parserId).toBe(exp.parserId);
      expect(preview.value.missions).toBe(exp.missions);
      expect(preview.value.tabs).toBe(exp.tabs);
      expect(preview.value.rejects).toBe(exp.rejects);
      expect(preview.value.dupesHint).toBe(exp.dupes);
    });
  }
});

describe('E5-T05 corpus acceptance · file-level classes fail loud', () => {
  for (const [rel, exp] of Object.entries(EXPECT_FATAL)) {
    it(`${rel} → ${exp.code} (${exp.note})`, async () => {
      const preview = await previewText(makeAdapter(), rel);
      expect(preview.ok).toBe(false);
      if (preview.ok) return;
      expect(preview.error.code).toBe(exp.code);
    });
  }
});

describe('E5-T05 corpus acceptance · the census runs both ways', () => {
  it('every corpus file has an expectation and every expectation a file', () => {
    const onDisk = corpusFiles().sort();
    const covered = [
      ...Object.keys(EXPECT_BASIC),
      ...Object.keys(EXPECT_HOSTILE),
      ...Object.keys(EXPECT_FATAL),
    ].sort();
    expect(covered).toEqual(onDisk);
  });

  it('unicode titles survive the full preview→plans path undamaged', async () => {
    const adapter = makeAdapter();
    const preview = await previewText(adapter, 'onetab/hostile-unicode-bom.txt');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const commit = await adapter.commit({ previewId: preview.value.previewId, dedupeMode: 'skip' });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const titles = commit.value.missions.flatMap((m) => m.tabs.map((t) => t.title));
    expect(titles.some((t) => t.includes('Café'))).toBe(true);
    expect(titles.some((t) => /[一-鿿]/.test(t))).toBe(true);
    expect(titles.some((t) => /[؀-ۿ]/.test(t))).toBe(true);
  });
});
