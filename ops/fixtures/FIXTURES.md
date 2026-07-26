# Fixture attribution log (import corpus)

**Law (README):** real-format import fixtures must be sanitized, attribution-logged here, and
privacy-reviewed before merge (roadmap R-14 gate). **Review outcome (2026-07-26, E7-T01):** every
corpus file is **authored synthetic** — no third-party export file, user data, or copied content
rides this corpus. All hosts are RFC 2606 reserved domains (`example.com`, `example.org`,
`example.net`); all titles are original prose. License: project-internal (authored in-repo), no
external attribution required. The privacy census is executable:
`ops/tests/unit/fixtures/corpus-privacy.test.ts`.

**Grammar sources (2026-07-26 grounding):** OneTab — its public export convention
(`<url> | <title>` lines, blank-line group breaks, bare-URL lines lawful); Session Buddy — the
classic v3 JSON export shape (top-level session array; `windows[].tabs[]` with `url`/`title` and
tab metadata); Netscape — the `NETSCAPE-Bookmark-file-1` document family every browser
imports/exports. Grammars are reconstructed from the tools' documented/observed export shapes and
encoded in the generators (`ops/fixtures/generators/`); divergence discovered at dogfood ⇒
corpus + parser fix in the same PR (ADR note `docs/adr-notes/e7-fixture-corpus.md` §2).

## OneTab (`<url> | <title>` lines, blank-line groups)

| File                                                         | Class              | What it pins                                            |
| ------------------------------------------------------------ | ------------------ | ------------------------------------------------------- |
| `ops/fixtures/import/onetab/basic.txt`                       | happy path         | titled + bare lines, one blank-line group break          |
| `ops/fixtures/import/onetab/hostile-crlf-blank-noise.txt`    | line-noise         | CRLF endings, whitespace-only separators, stray blanks   |
| `ops/fixtures/import/onetab/hostile-mega-line.txt`           | size-guard         | one ~4 KB title line (E_FILE_GUARD class)                |
| `ops/fixtures/import/onetab/hostile-schemes-malformed.txt`   | scheme quarantine  | javascript:/data:/chrome:/ftp:, non-URL tokens, dupes    |
| `ops/fixtures/import/onetab/hostile-separator-drift.txt`     | grammar drift      | missing/empty/tight pipes, orphan titles, non-URL notes  |
| `ops/fixtures/import/onetab/hostile-unicode-bom.txt`         | encoding           | UTF-8 BOM, NFC vs NFD pairs, CJK, RTL, ZWJ emoji         |

## Session Buddy (classic v3 JSON session array)

| File                                                                    | Class             | What it pins                                                |
| ----------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| `ops/fixtures/import/sessionbuddy/basic.json`                           | happy path        | named + unnamed sessions, windows, pinned, empty title       |
| `ops/fixtures/import/sessionbuddy/hostile-empty-array.json`             | edge-valid        | `[]` — parses, imports zero sessions                        |
| `ops/fixtures/import/sessionbuddy/hostile-missing-url-additive.json`    | row quarantine    | missing/empty `url`, additive unknown fields, `tabs`-less window |
| `ops/fixtures/import/sessionbuddy/hostile-stray-prefix.json`            | encoding          | stray byte before the array (observed wild export quirk)    |
| `ops/fixtures/import/sessionbuddy/hostile-truncated.json`               | parse reject      | JSON cut mid-string (E_FORMAT_UNKNOWN class)                |
| `ops/fixtures/import/sessionbuddy/hostile-wrong-types.json`             | schema drift      | `windows` as object, session as string, numeric `url`, null `tabs` |

## Netscape bookmarks (`NETSCAPE-Bookmark-file-1`)

| File                                                           | Class             | What it pins                                             |
| -------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `ops/fixtures/import/netscape/basic.html`                      | happy path        | prelude, folders, nesting, `DD` description, `ADD_DATE`   |
| `ops/fixtures/import/netscape/hostile-dupes.html`              | dedupe class      | same `HREF` at root and across folders                   |
| `ops/fixtures/import/netscape/hostile-empty-dl.html`           | edge-valid        | prelude with an empty root `<DL>`                        |
| `ops/fixtures/import/netscape/hostile-entities-crlf.html`      | escaping          | HTML entities in titles/HREFs, percent-encoded paths     |
| `ops/fixtures/import/netscape/hostile-no-doctype.html`         | grammar drift     | bare `<DL>` with no prelude (parser-policy class)        |
| `ops/fixtures/import/netscape/hostile-schemes.html`            | scheme quarantine | chrome:/javascript:/data:/file:/place:/about:/view-source: |
| `ops/fixtures/import/netscape/hostile-unclosed.html`           | malformed HTML    | unclosed `<A>`/`<H3>`/`<DL>`, stray text nodes, EOF cut  |

## Synthetic size classes (10k / 50k / 200k)

Generated, never committed:
`FIXTURES_WRITE=1 npx vitest run --project contract fixture-generators-write` writes every class
to `ops/fixtures/generated/` (gitignored) and re-verifies each file from disk.
Determinism is pinned by `ops/fixtures/generators/manifest.golden.json` (utf-8 bytes + crc32Hex
per class, one seed) and re-derived in the contract lane
(`ops/tests/contract/fixture-generators.test.ts`); regenerate the manifest with
`FIXTURES_UPDATE=1` riding the same PR as any generator change. Perf/importer lanes reuse the
same generators (audit A3) instead of growing private corpus builders.
