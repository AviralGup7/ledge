# E7-T04 · regression seed corpus (bug → test-first pipeline) — decision record

Milestone: EPIC E7 (RELIABILITY OPS), fourth work package. Roadmap row:
"Regression seed corpus | Bug→test-first pipeline discipline | M2 | S (ongoing)
| seeds/ | Every field bug lands a seed pre-fix". Frozen anchors: constitution
T-01 ("every field bug becomes a failing test before the fix, grafted into the
regression seed corpus" — `[GATE]`), EES §8 regression row ("every field bug →
failing test first, fix second; seed corpus curated … PR-blocking"), M2 test
requirements ("regression seed corpus begins"), audit A8 ("top-5 issue→
seed-corpus rule (E7-T04)").

No design forks were escalated: the row is an S-size discipline artifact and
both mechanical decisions follow house precedent (FIXTURES.md attribution
census, checklist-sync lockstep).

## Shape → curated registry + executable homes (not one file per bug)

A seed is a **record**, not a test file: `seeds/README.md` holds the schema,
frozen vocabulary (class × found-by), the operating ritual, and the registry.
Each row's `regression proof` column links the permanent executable home —
usually the suite the bug should have tripped. The census
(`ops/tests/unit/seeds/seeds-census.test.ts`, unit lane) validates structure,
vocabulary, id monotonicity (never reused), grafted-only-on-main, and that
every linked proof path exists on disk. This mirrors the FIXTURES.md
attribution-census pattern: curation content in a doc, covenant in an
executable census so the corpus can never silently graveyard.

## Backfill v0 — seven entries, one per defect class

SEED-0001 phantom-shelf ViewName divergence (fc-seed-−1953314806, 113c3a7) ·
SEED-0002 rename-then-assign dirty trap (fc-seed-159411701-class, 8823ed6) ·
SEED-0003 corpus byte-contract drift on checkout (66a8784) · SEED-0004
memory-engine cross-store copyback clobber exposed by the E6 selfTest actor
(2cf6687) · SEED-0005 workroom shell missing document language, caught by the
E7-T03 suite pre-fix — the discipline demonstrated end-to-end (ffa671e) ·
SEED-0006 undo-label hand-mirror 404, audit E4-F1 (34cee47) · SEED-0007 §4
catalog parity drift in lifecycle deciders (e5f74c2).

Selection law: in-repo found-then-fixed classes with a live executable proof;
pre-beta there are no true `field-report` rows — that class/founder pair is
reserved and the A8 weekly-digest top-5 amendment takes over post-beta.

## Ritual (failing test first, always)

Observe → seed a red `it`/hostile fixture against the pre-fix tree → smallest
lawful fix → graft one registry row in the same PR → curate (retired proof
paths update the row; the census keeps the link honest). `grafted: pending`
may not live on main.

## Census note

Wire census untouched (30C/9Q/13S/17W/5S). No source file changed: corpus +
census + docs only.
