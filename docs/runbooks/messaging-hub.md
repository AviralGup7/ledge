# Playbook: Messaging / hub (Blueprint §9 row 11)

**Truth law:** envelopes are contracts (ADR-010 v1 handshake); sender-context
is authority — a capability is envelope-derived, never payload-claimed.

## Detect

- Surfaces stuck in pending-honest states; cid timeouts; watermark-gap resync
  loops on rejoin; contract-census red after a verb change.

## Confirm

- chrome://extensions → SW console: envelope v check + boundary refusals are
  logged in the unified ring as rows (E_PAYLOAD_MALFORMED / E_VERSION_SKEW /
  refuse-class codes debug-level, warn on verbs' terminal failures).
- Census law: 30C/9Q/13S/17W/5S — a drift here is a contract PR, not a runtime
  event.

## Act

- Dead port / lost update: the rejoin SOP replays snapshot+watermark (the
  whole missed window re-sent) — surfaces never patch partial truth.
- Schema mismatch after update: the dual-read windows cover N/N−1 — confirm
  which side is stale before touching the registry.

## Repair

- Suspected forged context: refuse-path logs name the sender; the E6 force
  law is the template (console capability verified from the envelope).
- Registry edit discipline: additive-only payloads; refusals precede any
  durable claim; local census comes BEFORE contract fixtures are relaxed.

## Drill

- Witnesses: `src/application/contracts/contracts.test.ts`,
  `ops/tests/unit/surfaces/contract-compat.test.ts` (census pin),
  `ops/tests/unit/surfaces/fake-transport.test.ts` (resync/replay SOP),
  boundary fuzz in `pnpm test:security`.
