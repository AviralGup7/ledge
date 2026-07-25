# Chaos harness (E2-T09, EES §8)

Gate level: **nightly + release** (EES §8 row; M1 exit: _chaos 0-loss … nothing
user-facing without G1_). In CI: `ci:all` runs the lane on every PR; the
nightly workflow owns the `chaos-harness` job.

## What lives here

| File                                 | Role                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `points.txt`                         | The enumerated kill points — **single source of truth**. Every mutation path's crash boundaries land here (PR-template law). _Never remove points; deprecate by comment only._                                                             |
| `points-file.ts`                     | The ONE normalization (trim / drop blanks / drop comments) every consumer shares; also the digest input for evidence.                                                                                                                      |
| `manifest.ts`                        | Machine binding: point ⇒ owner suite + expectation. Reconciler half is **derived** from the owner suite's fixture catalog (never restated); marker half pins the canonical classification verdicts.                                        |
| `driver.ts`                          | The sweep: drives each point through its owner's torn-state fixtures/markers, runs the corrupted-journal seeds, folds outcomes into evidence rows.                                                                                         |
| `faults.ts`                          | `withFaults(engine, plan)` — IDB fault injection: deterministic seeded latency + planned one-shot failures. Typed (catalog `LedgeError`), annotated (`details.chaosOp/chaosOrdinal`), reversible (unwrap = new proxy over the same bytes). |
| `evidence.ts`                        | The G1 report schema + deterministic digest (`stableStringify` + sha256, clock-free, id-free).                                                                                                                                             |
| `evidence/g1-chaos-evidence.v1.json` | Committed golden — the reproducibility gate.                                                                                                                                                                                               |

The suite lives at `ops/tests/chaos/chaos-harness.test.ts` (vitest **chaos**
project: `src/**/*.chaos.test.ts` + `ops/tests/chaos/**`).

## Run

```bash
pnpm test:chaos                 # the lane (PR + nightly + release)
pnpm test:chaos:evidence        # refresh the golden (UPDATE_EVIDENCE=1)
```

## Adding a kill point (fail-closed by construction)

1. Add the line to `points.txt` (new flow ⇒ new owner suite).
2. Bind an owner: reconcile-side points get a fixture in the reconciler
   testkit's `KILL_POINT_FIXTURES`; boot-marker points get a
   `MARKER_POINT_EXPECTATIONS` entry + a driver scenario.
3. The constitution tests go red until the partition is exact again; refresh
   the evidence golden and review the diff.

Refresh policy: the golden is evidence, not a snapshot to rubber-stamp —
regenerate only alongside the code change that alters outcomes, and review the
JSON diff as part of the PR.

## Law notes (derived by the harness, documented where they bit)

- **Detection pathway for byte rot**: the budgeted boot tail-walk does not
  serve events; the refusing layer is the evidence scan's `readRange` — byte
  rot always degrades the boot at `evidence-scan` with outcome `recovered`
  and zero writes. Rot is never silently served (overlap) and healthy prefix
  bytes are served identically (honesty).
- **Anchor (head) drift**: poisons no served byte; the boot reconciles from
  the CRC-verified stream (`clean`), and prosecution is `scanFull`'s
  release-gate surface (`head-drift` suspect).
