# Playbook: Two-phase intents (Blueprint §9 row 2)

**Truth law:** a browser mutation is durable only after its intent is; SW death
between phases is a normal event, not an emergency.

## Detect

- Boot dangling-intents probe (`dangling intents` row on the health card).
- Recovery card disclosure listing conservative reconciles.

## Confirm

- Rescue console probe run: dangling count > 0 ⇒ `warn`.
- Expected class after any real crash/kill; persistent dangling intents on a
  stable profile are the anomaly (drift in resolver breadth lift or executor).

## Act

- Nothing manual at first: boot reconcile is the factory — conservative
  branch per intent family (complete-safe or leave-open + mark).
- If the SAME intent id reappears across boots: a terminal never lands —
  suspect exactly-once regression (ledger cid map or executor ack path).

## Repair

- Reboot once (reconcile reruns). Persistent ⇒ open the boot incident slot
  (rescue card data) + bundle; the ledger is durable truth, entries never
  hand-edited; a repair is at most a `R2` resolver-breadth law review.

## Drill

- Kill-point chaos post-accept/pre-execute (E2-T09 driver).
- Witnesses: `src/infrastructure/intents/intents.ledger.test.ts`,
  `ops/tests/e2e/recovery-w7.e2e.test.ts` (real kill/restart lane).
