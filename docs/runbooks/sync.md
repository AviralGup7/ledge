# Playbook: Sync (Blueprint §9 row 13) — future register (Tier 4)

**Status: not shipped.** Zero-knowledge sync is a v2 boundary proof (EPIC E9).
This page holds the frozen posture so the row is never answered with
improvisation.

## Frozen posture

- Local-first absolute: every v1 feature is fully functional with no account,
  no relay, no network (EES §7.6 is a gate, not a goal).
- Relay compromise class ⇒ the relay sees ciphertext + opaque ids only
  (ADR-021 sealing, ADR-042s shape); key mismatch ⇒ queue-and-wait + a
  plain-language notice; unknown remote types ⇒ skip + count, never crash.
- Recovery conflicts use the matrix proofs (rename/rename, delete/edit,
  conclude/edit — E9-T03 property suite).

## Detect (when shipped)

- Sync status probe row; paused queue visible as a plain state, never red.

## Drill (Tier 4)

- Two-harness reconciliation loopback (E9-T02); seal/open round trips
  (E9-T01 @50k events/s); merge commutativity/idempotency property suites.

## Until then

Any user request that smells like sync lands as a **diagnostics bundle +
parser/export answer**, never as ad-hoc cloud plumbing (ADR-028: nothing
leaves the device unless the user chooses to send it).
