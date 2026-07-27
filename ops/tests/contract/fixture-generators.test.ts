// E7-T01 · Generator determinism covenant (roadmap E7-T01 AC: "generators
// deterministic"; audit A3: seeded generators for perf-harness reuse). Every
// (format, size) class regenerates BYTE-IDENTICALLY on any platform and any
// run; the committed golden manifest pins utf-8 bytes + crc32Hex per class and
// this lane re-derives them. Exact-entry-count assertions pin the corpus
// contract the importers will stream (one entry per URL line / tab object /
// <DT><A HREF> node).
//
// Intentional regeneration (a generator change and its manifest bump land in
// the SAME PR — same discipline as the export covenant and perf baselines):
//   FIXTURES_UPDATE=1 npx vitest run --project contract fixture-generators
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { crc32Hex } from '@/shared-kernel/canon/index.js';
import {
  CORPUS_FORMATS,
  CORPUS_SEED,
  SIZE_CLASSES,
  generateCorpus,
  type CorpusFormat,
  type CorpusSizeClass,
} from '../../fixtures/generators/generate.js';

interface ManifestEntry {
  readonly bytes: number;
  readonly crc32: string;
}

interface CorpusManifest {
  readonly schemaV: 1;
  readonly seed: number;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
}

const MANIFEST_PATH = fileURLToPath(
  new URL('../../fixtures/generators/manifest.golden.json', import.meta.url),
);
const UPDATE = process.env['FIXTURES_UPDATE'] === '1';
const UTF8 = new TextEncoder();

const keyOf = (format: CorpusFormat, size: CorpusSizeClass): string => `${format}:${size}`;

/** One entry per tab/link — the importer-facing corpus contract, per format. */
const ENTRY_COUNT: Readonly<Record<CorpusFormat, (text: string) => number>> = {
  onetab: (text) => text.split('\n').filter((line) => line.startsWith('http')).length,
  sessionbuddy: (text) => (text.match(/"url": "/g) ?? []).length,
  netscape: (text) => (text.match(/<DT><A HREF=/g) ?? []).length,
};

const renderAll = (): ReadonlyMap<string, { text: string; entry: ManifestEntry }> => {
  const rendered = new Map<string, { text: string; entry: ManifestEntry }>();
  for (const format of CORPUS_FORMATS) {
    for (const size of SIZE_CLASSES) {
      const text = generateCorpus(format, size);
      rendered.set(keyOf(format, size), {
        text,
        entry: { bytes: UTF8.encode(text).length, crc32: crc32Hex(text) },
      });
    }
  }
  return rendered;
};

const readManifest = (): CorpusManifest => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

/** CI-runner budget for the full 9-class census render (local ≈ 4s; shared
 *  runners are the flake boundary — 5.6s observed on ubuntu-latest). Within
 *  the 60s house ceiling; NEVER raised to hide a generator slowdown — a
 *  materially slower census needs an ADR note, not a bigger number. */
const CENSUS_BUDGET_MS = 30_000;

describe('E7-T01 fixture generators · determinism covenant', () => {
  it(
    'the golden manifest shape is the 9-class census pinned to the corpus seed',
    { timeout: CENSUS_BUDGET_MS },
    () => {
      const rendered = renderAll();
      if (UPDATE) {
        const entries: Record<string, ManifestEntry> = {};
        for (const [key, { entry }] of rendered) entries[key] = entry;
        const next: CorpusManifest = { schemaV: 1, seed: CORPUS_SEED, entries };
        writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      }
      const manifest = readManifest();
      expect(manifest.schemaV).toBe(1);
      expect(manifest.seed).toBe(CORPUS_SEED);
      expect(Object.keys(manifest.entries).sort()).toEqual([...rendered.keys()].sort());
    },
  );

  it.each(SIZE_CLASSES)('size class %i regenerates byte-identically to the golden', (size) => {
    const manifest = readManifest();
    for (const format of CORPUS_FORMATS) {
      const text = generateCorpus(format, size);
      const golden = manifest.entries[keyOf(format, size)];
      expect(golden, `manifest row ${format}:${size}`).toBeDefined();
      expect(
        { bytes: UTF8.encode(text).length, crc32: crc32Hex(text) },
        `${format}:${size} drifted from the golden manifest`,
      ).toEqual(golden);
      expect(ENTRY_COUNT[format](text), `${format}:${size} entry count`).toBe(size);
    }
  });

  it('distinct formats and sizes emit distinct corpora (anti-degenerate census)', () => {
    const texts = new Set<string>();
    for (const format of CORPUS_FORMATS) {
      texts.add(generateCorpus(format, 10_000));
    }
    texts.add(generateCorpus('onetab', 50_000));
    expect(texts.size).toBe(4);
  });
});
