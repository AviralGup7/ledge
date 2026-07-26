# Fixture corpus (T-10 ethics law)

- synthetic-first: generators are seeded + deterministic
  (`ops/fixtures/generators/`, one seed per corpus family; the golden manifest
  pins bytes + crc32Hex per class, re-derived in the contract lane).
- real-file fixtures (OneTab / Session Buddy / Netscape exports) must be
  sanitized, attribution-logged in FIXTURES.md, and privacy-reviewed before
  merge (Roadmap R-14 gate). The committed import corpus
  (`ops/fixtures/import/`) is 100% authored synthetic — RFC 2606 reserved
  domains only; the privacy census is executable
  (`ops/tests/unit/fixtures/corpus-privacy.test.ts`).
- golden journals/exports are PUBLIC-API test vectors: changing one requires
  checking A-13 covenant compatibility.

## Layout

| Path                       | Content                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `canon/ events/ migrations/ storage/` | E1–E2 goldens (journal/canon/storage public vectors)               |
| `import/`                  | E7-T01 committed import corpus: 3 format-faithful basics + hostile variants   |
| `generators/`              | E7-T01 seeded deterministic generators (10k/50k/200k classes) + golden manifest |
| `generated/`               | on-demand corpora written by `FIXTURES_WRITE=1` (gitignored)                  |
| `FIXTURES.md`              | attribution log (per-file class, provenance, privacy review)                  |
