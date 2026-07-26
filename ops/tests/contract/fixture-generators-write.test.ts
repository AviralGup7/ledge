// E7-T01 · On-demand corpus writer (M4 dogfood aid — importer previews exercised
// against real files on disk). Skipped unless explicitly armed so the contract
// lane never writes as a side effect:
//
//   FIXTURES_WRITE=1 npx vitest run --project contract fixture-generators-write
//
// Writes every (format, size) class to ops/fixtures/generated/ (gitignored) and
// re-verifies each written file against the generator in-memory — the one
// generator is the only implementation, so disk and lanes can never drift.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_FORMATS,
  SIZE_CLASSES,
  generateCorpus,
  type CorpusFormat,
} from '../../fixtures/generators/generate.js';

const WRITE = process.env['FIXTURES_WRITE'] === '1';
const OUT_DIR = fileURLToPath(new URL('../../fixtures/generated/', import.meta.url));

const EXT: Readonly<Record<CorpusFormat, string>> = {
  onetab: 'txt',
  sessionbuddy: 'json',
  netscape: 'html',
};

(WRITE ? describe : describe.skip)('E7-T01 corpus writer (armed with FIXTURES_WRITE=1)', () => {
  it('writes all format × size classes and re-verifies them from disk', () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let written = 0;
    for (const format of CORPUS_FORMATS) {
      for (const size of SIZE_CLASSES) {
        const text = generateCorpus(format, size);
        const path = `${OUT_DIR}${format}-${size}.${EXT[format]}`;
        writeFileSync(path, text, 'utf8');
        expect(readFileSync(path, 'utf8'), `${format}:${size} disk round-trip`).toBe(text);
        written += 1;
      }
    }
    expect(written).toBe(CORPUS_FORMATS.length * SIZE_CLASSES.length);
  });
});
