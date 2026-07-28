# Docs hygiene (E8 era) — retirement ruling

User-directed sweep ("go through documents, delete useless and outdated
ones"). The docs gate (`ops/tests/unit/docs/docs-gate.test.ts`) pins the
active set — every runbook, the degradation matrix, threat model, README,
a11y checklist, and `docs/recovery-runbook-v0.md` (linked from the runbook
index as the Recovery playbook, status active) were verified pinned or
load-bearing and stay untouched. All seven locked governance documents are
canon: append-only, never edited, never deleted.

## Retired (deleted)

- `docs/PROJECT-BOOTSTRAP.md` — the Phase-8 scaffold snapshot written when
  "zero production feature code" existed. Its repository map no longer
  describes the repo (wrong filenames, placeholder-era claims like the
  E4-era quiet page) — exactly the rotten-witness class the docs gate
  exists to fight. Nothing gated it; the only mention anywhere is one
  historical line in `docs/adr-notes/e7-docs-set.md` (an append-only record
  of E7's anchors — that mention stays honest because it refers to the E7
  past, not to a living document). Its onboarding substance lives on in
  `README.md` and the E7 docs set.

## Repaired (not deleted)

- `docs/README.md` — the 6-line docs index was stale ("Export-format
  covenant lands here at E5-T04" — landed long ago) and silent about
  `adr-notes/`, the matrices, and the E8 AI docs. Rewritten as the current
  map; no content lost (the two live facts — runbooks keyed to §9 rows and
  `permissions.md`'s ADR-022 role — carried forward verbatim).

## Ruling (recorded so the sweep stays conservative)

Deletion criteria, in order: (1) untriggered by any gate/test/script; (2)
factually false as a description of the present repo; (3) substance carried
by a living successor. Only `PROJECT-BOOTSTRAP.md` met all three. Anything
append-only (governance, ADR notes) or gate-pinned is by definition not a
deletion candidate; staleness there is repaired in place or amended, never
erased.
