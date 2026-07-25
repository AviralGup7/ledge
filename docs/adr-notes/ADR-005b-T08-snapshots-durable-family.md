# ADR note — snapshots joins the ADR-005 durable-write family (E2-T08)

**Status:** addendum to ADR-005 (state management / single-writer) — route-level
composition, no decision reversal. **Authored:** 2026-07-25, E2-T08 review.

## Question

`infrastructure/snapshots` (E2-T08) materializes the §5 `sessions` store from
`SnapshotTaken` events: its test kit opens the journal + memory engine directly,
like every other durable-family kit. The `writer-concentration` depcruise rule —
which guards ADR-005's "only the journal/storage/recovery/projections/intents
family may import the durable write seam" — flagged it: `snapshots/` was not in
the family route.

## Decision

`snapshots` **is** durable-write family by construction:

- it owns a journal→store materialization (the sessions projector — same
  projection-engine law family as projections/),
- it owns the read-only part-completeness integrity probe over that store
  (same "prosecute, never repair" posture as journal/recovery),
- it owns the §5 retention _policy_ whose sweep (E3-T04, then compaction
  consumers E2-T11) acts on the same stores,
- and the compaction/purge machinery (ADR-020, E2-T11) will read the same
  durable seams.

Nothing outside the family gained power: no application, roots, surfaces, or
chrome code may import journal/storage; the rule's enforcement surface is
unchanged for every non-family module.

## Mechanism

`.dependency-cruiser.cjs` `writer-concentration.from.pathNot` family regex
gains `snapshots`. Rule name, severity, and `to` clause untouched.

## Consequences

- The snapshots test kit composes worlds exactly like the journal/projections
  kits (openEngine + createJournal + projection engine) — one pattern, no
  special case.
- Any _future_ module attempting the same import lights the same red gate
  unless it earns family membership by an equally argued ADR note — the
  constitution's escalation path, working as designed.
