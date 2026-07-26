// E7-T01 · Corpus privacy/licensing tripwire (roadmap E7-T01 AC: "corpus
// licensing/privacy clean"; README law: attribution-logged in FIXTURES.md).
// Two executable laws over the COMMITTED import corpus:
//  1. every http(s) URL inside ops/fixtures/import/** resolves to an RFC 2606
//     reserved domain (example.com/org/net, subdomains included) — no
//     real-world host or personal data can ride the corpus;
//  2. FIXTURES.md attribution census runs BOTH WAYS: every committed corpus
//     file is logged, and every logged path exists on disk.
// Non-http(s) scheme lines (the quarantine hostility classes: chrome:, data:,
// javascript:, file:, place:, about:) are out of the privacy surface by
// construction — they carry no host and never fetch.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURES_ROOT = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const IMPORT_ROOT = `${FIXTURES_ROOT}/import`;
const ATTRIBUTION_LOG = `${FIXTURES_ROOT}/FIXTURES.md`;

const LISTED_PREFIX = 'ops/fixtures/import/';

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );

const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

const hostAllowed = (rawUrl: string): boolean => {
  try {
    const host = new URL(rawUrl).hostname;
    return RESERVED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false; // unparseable URL — flagged by the caller as a violation itself
  }
};

describe('E7-T01 import corpus · privacy and attribution laws', () => {
  it('every http(s) URL in the committed corpus lives on an RFC 2606 reserved domain', () => {
    const files = walk(IMPORT_ROOT).filter((path) => statSync(path).isFile());
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/https?:\/\/[^\s"'<>|\\]+/gi)) {
        const url = match[0];
        if (!hostAllowed(url)) violations.push(`${path}: ${url}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('FIXTURES.md attribution census matches the committed corpus both ways', () => {
    const onDisk = new Set(
      walk(IMPORT_ROOT)
        .filter((path) => statSync(path).isFile())
        .map((path) => path.slice(path.indexOf(LISTED_PREFIX))),
    );
    const loggedText = readFileSync(ATTRIBUTION_LOG, 'utf8');
    const logged = new Set(
      [...loggedText.matchAll(/`(ops\/fixtures\/import\/[^`]+)`/g)].map((m) => m[1] ?? ''),
    );
    expect([...onDisk].sort(), 'corpus files missing from FIXTURES.md').toEqual([...logged].sort());
  });
});
