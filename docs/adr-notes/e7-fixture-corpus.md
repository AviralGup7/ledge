# ADR note — E7-T01 fixture corpus (import formats + synthetic size classes)

**Status:** decisions taken while building the fixture corpus (committed import
corpus `ops/fixtures/import/`, seeded generators `ops/fixtures/generators/`,
attribution log `FIXTURES.md`, privacy + determinism tripwires). No ADR
reversals; the work composes within ADR-040 (zone-2 untrusted input law —
import files are hostile by default), ADR-044 (FUTURE import-format list),
EES §2.14 (importers size-capped, chunked, timeout-guarded; rejects
quarantined never fatal), roadmap audit A3 + the M4 regression note
("E7-T01 must predate M4").
**Authored:** 2026-07-26, E5-WP4 close-out.

Each entry: the question, the decision, the why. **[follow-up]** names the
milestone that owns the remaining work.

---

## 1. "Real" corpora with "licensing/privacy clean" — the AC's honest reading

**Question:** roadmap E7-T01 asks for "Real OneTab/SessionBuddy/bookmarks
exports" while its exit criteria require "Corpus licensing/privacy clean" and
the README law requires sanitization + attribution before merge. Actual user
export files are privacy-dirty by definition (browsing history is personal
data) and un-licensable for redistribution. What is "real", then?

**Decision:** **format-faithful, content-synthetic.** Grammars are
reconstructed from the tools' documented/observed export shapes (grounded
2026-07-26: OneTab `<url> | <title>` lines + blank-line groups; Session Buddy
classic v3 JSON session array; `NETSCAPE-Bookmark-file-1`); content is authored
in-repo — RFC 2606 reserved domains (`example.com/org/net`) and original titles
only. "Real" binds the BYTES A PARSER MEETS (grammar, encoding, hostility
classes), never the provenance of a stranger's browsing history.

**Why:** the M4 regression note's fear is _malformed reality_, not _someone
else's reality_ — parsers converge on grammar+frost, and grammar+frost is
reproducible synthetically with zero privacy debt. The privacy law is
executable, not aspirational: `corpus-privacy.test.ts` fails the unit lane if
any committed corpus file carries a URL outside the reserved-domain allowlist,
and the FIXTURES.md attribution census runs both ways (every file logged;
every logged path on disk).

**Tripwire's first catch (recorded, not silently fixed):** the scan flagged
`https://exa mple.com/…` — a _deliberately_ malformed hostile line whose
truncated prefix parsed as non-reserved host `exa`. The fixture moved the
space break into the path (`https://example.com/split 1 …`), preserving the
quarantine class with a reserved prefix. The scanner was **not** weakened:
unparseable tokens are violations by design, because a scanner that cannot
vouch for a token cannot vouch for the corpus.

## 2. Grammar sources and the divergence protocol

**Decision:** grammars ride on the public, documented export conventions of
the three tools (cited in FIXTURES.md per format). Any divergence discovered
at dogfood (WP5 importers, M4 exit) is fixed as **corpus + parser in the same
PR** — the corpus defines acceptance, so a corpus-only change is the bug
report, never the fix.

**Why:** with synthetic corpora the risk inverts from "not real enough" to
"confidently wrong" — a self-consistent fiction the parsers then encode. The
protocol names who blinks first (both, together, in one diff) so divergence
can never ossify into a second grammar.

## 3. Hostility is a named census, not vibes

**Decision:** 14 hostile variants across the 3 formats, each file pinning
exactly one parser-policy class, listed in FIXTURES.md: line-noise (CRLF,
whitespace separators), grammar drift (separator variants, missing prelude),
row quarantine (missing/empty/typed-wrong `url`), scheme quarantine
(javascript:/data:/chrome:/file:/place:/about:/view-source:/ftp:), encoding
(BOM, stray prefix bytes, NFC/NFD, CJK, RTL, ZWJ emoji), parse reject
(truncated JSON), size-guard (4 KB mega-line), escaping (entities,
percent-encoding), dedupe (cross-folder HREF repeats), edge-valid (empty
array / empty root DL that must parse to zero entries).

**Why:** "real-world export files are hostile" (the M4 note) becomes
actionable only as a census with a policy class per cell — each fixture is a
standing question the WP5 parsers must answer; a vague pile of corrupt files
would let classes regress silently.

## 4. Determinism mechanism — one seed, format salts, a golden manifest

**Decision:** generators are dependency-free TS (own mulberry32 — `Math.imul`
arithmetic is integer-exact across engines, so streams are platform-stable);
`CORPUS_SEED` is the family seed, each format XORs a named salt; every
(format, size) class emits **exactly N** entries. Determinism is pinned by
`manifest.golden.json` (utf-8 bytes + `crc32Hex` per class — the same checksum
vocabulary as journal §4 and the export covenant §3) and re-derived in the
**contract** lane; regeneration is `FIXTURES_UPDATE=1` riding the same PR as
any generator change (precedent: `COVENANT_EXAMPLES_UPDATE`, `PERF_UPDATE`).

**Why the contract lane, not unit:** regenerating all 9 classes costs ~9 s —
within the 60 s/test law but rude in the unit wall; contract is the PR-gated
lane whose remit is exactly "our artifacts keep their promises". The unit lane
keeps the privacy census (file-level, instant).

**Measured:** 200k classes — onetab 15.7 MB, sessionbuddy 107.7 MB,
netscape 25.7 MB; full 9-class regeneration ≈ 9 s; write-mode disk
re-verification ≈ 3.5 s.

## 5. The corpus writer is an armed test, not a new tool

**Decision:** writing size classes to disk (M4 dogfood needs real files for
importer previews) is `ops/tests/contract/fixture-generators-write.test.ts`,
skipped unless `FIXTURES_WRITE=1`, writing to gitignored
`ops/fixtures/generated/` and re-verifying every written file from disk. No
new dev-dependency, no second implementation of the generator (the one thing
that could ever drift).

**Why:** ADR-044's boring-stack doctrine (≤5 runtime deps, removal plans)
means a CLI runner (vite-node/tsx) is a real cost; env-armed vitest runs are
the repo's established update/write pattern and keep exactly one generator
implementation as the source of truth.

## 6. Scope discipline — what this WP deliberately did not do

- The perf harness's private corpus builders (search/export scenarios) were
  **not** migrated to these generators. A3 says generators must be reusable
  by the harness; it does not charter a refactor here.
  **[follow-up]** migration is a cleanup call for the perf-lane milestone
  (E8-T15 remit) — the seam now exists.
- No parser code: WP5 (E5-T05) consumes `ops/fixtures/import/**` as its
  acceptance set; each FIXTURES.md class row becomes a parser test row.
- No `budgets.json` change: corpora ride no bundle entrypoint.

## 7. Finding (fixed in flight, follow-up commit): git normalization silently retires hostile classes

**Caught at ship time:** the repo-wide `.gitattributes` law (`* text=auto eol=lf`)
normalized CRLF → LF **in the committed blob** of `hostile-crlf-blank-noise.txt`
and stripped the mixed endings of `hostile-unicode-bom.txt` — the two hostile
classes whose bytes ARE the test condition were castrated in the corpus commit
itself (`7595d32`), with only an add-time warning as signal.

**Fix (same WP, honest second commit — no force-push):**
`ops/fixtures/import/** -text` in `.gitattributes` (the corpus is a byte
contract; the repo-wide LF law keeps every other file), index refreshed under
the rule (`i/crlf`, `i/mixed` verified), plus a **byte-honesty tripwire** in
`corpus-privacy.test.ts`: CRLF presence, BOM bytes (EF BB BF), mega-line
length, stray-prefix byte — a normalization pass now fails the unit lane
instead of silently editing the corpus.

**Why it belongs in this note:** the hazard class ("tooling helpfully rewrites
fixture bytes") generalizes — any future byte-significant fixture family must
declare `-text` up front and assert its bytes in the lane. The privacy scan's
strict-unparseable posture (§1) and this tripwire are the same law: a corpus
you cannot verify byte-for-byte is a corpus you do not have.
