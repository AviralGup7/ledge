<!-- Constitution §5: all ten review axes apply. Keep small: S/M labels auto; XL needs justification below. -->

## What & Why

## Contracts touched

<!-- messages / events / ports / storage — list each or write "none" -->

## Events added/changed

<!-- append-only law (A-09): registry entry included? -->

## Budgets impacted

<!-- perf/memory/bundle rows changed? attach harness numbers for perf-sensitive diffs (§7 measure-first) -->

## Kill points added (chaos points.txt)

<!-- REQUIRED if this PR adds a mutation path (T-04) -->

## Docs updated

<!-- §9 trigger checklist: registries, runbooks, ADR-needed? -->

## Risk

<!-- blast radius: what breaks if this is wrong? rollback path -->

## Checklist

- [ ] Gates green locally (`pnpm ci:all`)
- [ ] New behavior ships with its test (bugfix = seed first, T-01)
- [ ] Failure modes from Blueprint §9 covered, not just happy path
- [ ] Copy comes from the catalog (no inline strings)
- [ ] No new permissions / no new egress / no new dependencies without admission checklist (D-02)
