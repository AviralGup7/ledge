# Regression seed corpus (E7-T04) — policy, schema, registry

**Law (constitution T-01, EES §8 regression row):** every field bug becomes a
**failing test first**, the fix second; the seed is grafted into this corpus in
the same change. PR-blocking — a defect is not "fixed" until its seed is
grafted and green. Curation (audit A8 rule, pre-beta form): **every** confirmed
defect class lands a seed; post-beta the support-digest top-5 rule takes over
(field reports outrank harness finds).

A "seed" is not a new test file per bug: it is a **curated record** whose
`regression proof` column points at the permanent executable home (usually the
suite the bug should have tripped on its own). The corpus stays grafted, not
graveyarded — census (`ops/tests/unit/seeds/seeds-census.test.ts`) validates
every row against the worktree on each `pnpm test`.

## Schema (one row per seed)

| field              | law                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seed`             | `SEED-NNNN`, unique, ascending; never reused after graft                                                                                               |
| `class`            | frozen vocabulary: `projection-divergence` · `durability-fixture` · `corpus-integrity` · `ui-shell` · `copy-parity` · `domain-parity` · `field-report` |
| `found by`         | frozen vocabulary: `property-fuzz` · `unit-suite` · `a11y-suite` · `harness` · `audit` · `chaos` · `field-report`                                      |
| `symptom`          | one line: what a user/suite could observe                                                                                                              |
| `regression proof` | test path(s) whose `it` fails pre-fix, passes post-fix                                                                                                 |
| `fix`              | landing commit (short hash)                                                                                                                            |
| `grafted`          | `yes` — the entry's ecosystem state (a placeholder `pending` row may survive at most one PR)                                                           |

New classes/founders join the vocabulary via this file's edit in the same PR as
their first row (the census enforces the freeze).

## Registry

| seed      | class                 | found by      | symptom                                                                                                                                                                  | regression proof                                                                    | fix     | grafted |
| --------- | --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------- | ------- |
| SEED-0001 | projection-divergence | property-fuzz | replay mirror lost a whole ViewName row — a "phantom shelf" divergence between mirror and engine at fc-seed-−1953314806                                                  | `ops/tests/property/replay-purge-law.property.test.ts`                              | 113c3a7 | yes     |
| SEED-0002 | projection-divergence | property-fuzz | rename-then-assign before formation dirtied the missions view (fc-seed-159411701-class dirty trap)                                                                       | `src/infrastructure/projections/projections.test.ts`                                | 8823ed6 | yes     |
| SEED-0003 | corpus-integrity      | unit-suite    | CRLF/BOM fixture bytes were lost after checkout (`-text` drift made git "normalize" them) — hostile classes stopped being byte-honest                                    | `ops/tests/unit/fixtures/corpus-privacy.test.ts`                                    | 66a8784 | yes     |
| SEED-0004 | durability-fixture    | unit-suite    | memory-engine committed by whole-table copyback: an overlapping txn (diagnostics selfTest) wiped journal rows it never touched — "append → recompose → read" lost events | `src/roots/roots.test.ts`                                                           | 2cf6687 | yes     |
| SEED-0005 | ui-shell              | a11y-suite    | workroom entrypoint shipped without `lang` — document-language law violated the moment the §7.4 shell audit first ran                                                    | `ops/tests/a11y/contrast-zoom.test.ts`                                              | ffa671e | yes     |
| SEED-0006 | copy-parity           | audit         | hand-mirrored undo-label list let `msg.undo.archived` 404 to a raw key string at render (audit E4-F1)                                                                    | `ops/tests/unit/surfaces/copy.test.ts` · `ops/tests/unit/surfaces/guardian.test.ts` | 34cee47 | yes     |
| SEED-0007 | domain-parity         | harness       | lifecycle deciders drifted from the §4 catalog (event field parity: `ParkIntentAccepted.intentId`, per-entry `TrashPurged`, pure `MissionArchived`)                      | `src/domain/lifecycle/transitions.test.ts`                                          | e5f74c2 | yes     |

## Operating ritual (the discipline, mechanically anchored)

1. **Observe** — field report, support digest, chaos/perf/a11y red, review find.
2. **Seed first** — write the failing `it` (or hostile fixture row) pinned to the
   real behavior; it MUST be red against the pre-fix tree.
3. **Fix** — smallest lawful change; the seed goes green.
4. **Graft** — one registry row here (same PR). `grafted: pending` is allowed
   only while its proof is in review; the census fails on a stale pending row
   (schema freeze is the same edit).
5. **Curate** — regressions never delete seeds; a retired proof path updates
   the row (the census keeps the link honest).

**Post-beta amendment (audit A8):** the weekly support digest's top 5 issues
each land a seed before their fix — field reports are class `field-report` and
outrank every harness find.
