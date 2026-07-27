# Playbook: Journal (Blueprint §9 row 1)

**Truth law:** ack ⇒ durable; sealed segments immutable; never fake durability.
**Failure modes:** write ack timeout · CRC mismatch · torn segment.

## Detect

- Tail-scan probe (`journal tail CRC freshness`) flags a suspect segment at
  boot or in the rescue console probe run.
- Append ack >250ms ⇒ caller treats as not-durable (abort path; idempotency
  key prevents double-append on retry) — transient only.
- Full scan (rescue console action) — the C24-cadenced deep verify.

## Confirm

- Quiet page → rescue console → probe catalog: `journal tail CRC freshness`
  row reads `warn`/`fail` with suspect count.
- Export bundle → `journalTailScan` block: `{status, suspects}`.

## Act

- Append-path fault (transient class): retry ×2; persistent ⇒ core read-only
  mode, calm banner, and this playbook's repair arm.
- CRC/torn segment: **truncate-to-last-good** — cut at segment N−1, emit
  `SnapshotReconciled` for exactness, surface the honest scope.

## Repair

- Rescue console → integrity scanner (tail first; full scan behind the 7-day
  cadence law / rescue-console capability override).
- After repair: projector rebuild (read models disposable — see
  [projections.md](projections.md)).
- Purge-law hygiene: excluded bytes must be physically absent post-compaction
  (property gate proves it; verify via soak if the corruption class was purge).

## Drill

- Chaos: kill SW at append boundaries (ops/chaos/points.txt driver).
- Property seeds: seeded truncations/bit-flips → truncate+reconcile exactness
  (`src/infrastructure/journal/core/journal.integrity.property.test.ts`).
- Witnesses: `src/infrastructure/journal/core/journal.test.ts`,
  `src/infrastructure/journal/compact/compact.test.ts`.

**Escalate (support digest):** bundle + BootReport id + probe run.
Calibration: false-positive suspect on a clean profile ≈ 0 — treat any repeat
as a seed-corpus candidate (E7-T04 graft first, fix second).
