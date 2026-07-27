# Playbook: Diagnostics (Blueprint §9 row 14)

**Truth law:** logging must never hurt the product — drop-oldest under
pressure, fail-drop on redactor fault, no-op mode is fully lawful (Blueprint
§9: "product must work with logging dead").

## Detect

- `diag-selftest` probe row (eleventh registry row) ⇒ `degraded` posture.
- Ring rows missing while acts are known to have run (queue-orphan class);
  `ring-dropped-queued` marker rows naming the loss count.

## Confirm

- Rescue console probe run: self-test row + the ten §12 rows' freshness.
- Export bundle: `redactor` block (`selftest-pass` vs `degraded`), ring slice.

## Act

- Redactor degraded: entries fail-drop (never raw) — the ring is thin by LAW,
  not by accident; restart once (self-test reruns at boot); persistent ⇒
  treat as redactor defect (seed first).
- Ring silent with probes green: flush-queue was orphaned by SW death —
  expected-class loss (queued entries are diagnostics, never truth); act
  once more and re-read the ring.

## Repair

- Bundle export degraded: run probes, read rows directly (the bundle is a
  cache of what probes already know); export refusals carry typed reasons.
- Include-addresses flip: expires ≤24h read-side — a bundle older than the
  window re-redacts; verify the meta status before accusing the redactor.

## Drill

- Witnesses: `ops/tests/unit/infrastructure/diagnostics.test.ts` (sabotage
  fail-drop, retention drop-oldest, decay fixture, bundle hygiene),
  `ops/tests/unit/application/queries.test.ts` (legacy degrade path when the
  seam is unwired).
