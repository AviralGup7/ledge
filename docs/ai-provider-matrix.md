# AI provider matrix (Blueprint §9 row 7) — v1 provisions

The ladder's legal rungs, in resolution order (elevated-first, heuristic last —
`PROVIDER_MATRIX_V = 1` in `src/infrastructure/ai/ladder.ts`). A rung ships only
when its witness column is green; everything below the shipped line is a
provision, not a promise. ADR-018's laws apply to every row: provider failure ⇒
circuit-break + next rung; malformed output ⇒ reject + count, never shipped;
cloud depth-mode is opt-in with per-day budgets and the redaction gateway.

| rung | provider id  | class                                        | availability                                          | breaker                                  | status                                                                                                                           | witness                                                                                                                                    |
| ---- | ------------ | -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 3    | `clouddepth` | cloud depth-mode                             | opt-in, budgeted/day                                  | opens at 3 strikes                       | **provision** — dir is a `.gitkeep` shell                                                                                        | E8 milestone rows (T04+)                                                                                                                   |
| 2    | `builtin`    | Chrome built-in AI                           | capability-detected                                   | opens at 3 strikes                       | **provision** — dir is a `.gitkeep` shell                                                                                        | E8-T06 (absence = invisible degrade)                                                                                                       |
| 2    | `ondevice`   | `ondevice-fwd-v1` WASM model in the workroom | capability-detected (deferred rung, yield-on-absence) | opens at 3 strikes — yields never strike | **shipped** (E8-T03; E8-T04 adds `mission-summary`; E8-T05 adds `mission-brief` — same rung/cell, absence-preference terminal)   | M1–M4/N1–N5/L1 · S1–S5/L1 summaries · A1–A6/B1–B6 briefs · `check:ondevice-model` · `check:shadow-eval` (margin 0.953 ≥ 0.50; G10/G11/G12) |
| 1    | `heuristic`  | `heuristic-domain-time-v1`                   | always (offline, free)                                | **never breaks**                         | **shipped** (E8-T04: also the §6.3 fail-down summary form, units H1–H5; **no `mission-brief` capability by design — E8-T05 J2**) | unit/property/chaos suites + S5 forced-rung law                                                                                            |

## Constants (versioned with the matrix)

- `BREAKER_OPEN_AT_FAILURES = 3`, `BREAKER_COOLDOWN_MS = 60_000`, half-open probe
  after cooldown (`src/infrastructure/ai/ladder.ts`).
- `HEURISTIC_NAMER_CONFIDENCE = 0.55` — §6.11 LOW band under R7's frozen
  constants (MED ≥ 0.60) → the neutral heuristic frame; shallow truth never
  borrows the suggestion affordance (ADR-note F3).
- Lane deadlines: interactive 2.5s (EES §7.1 budget) · maintenance 30s ·
  background 2min (`AI_LANE_DEADLINE_MS`); lanes admit
  interactive > maintenance > background; background closed until a caller-proven
  idle+battery window exists (ADR-note F4).
- Job attempt accounting: `JOB_RETRY_CLAIMS = 3`, claim #4 runs
  `forceHeuristic`, failure there is `attempts-exhausted` — terminal, counted.
- On-device calibration (E8-T03, ADR-note H3): accept floor `0.60`, dual
  margin `0.12`, sharp bar `0.90`, mission-grade logit `≥ 1.0` (chaff register
  may name its whole story, never half a dual); stamps
  `{0.88, 0.85, 0.72, 0.64}` — vocabulary pinned by shadow-eval G6.
- Absence-preference (E8-T05, ADR-note J1/J2): `mission-brief` attempts end
  **done-and-silent** on rung-less or pure-yield outcomes — terminal, no
  artifact, never counted (the `silentDone` census is the probe-visible
  evidence). Brief budgets: card ≤ 420 chars, producer hints ≤ 200 chars each;
  two-sentence floor (state alone is not a brief, J7).

## Reject + count (Spec §6.1 / EES §2.12)

Every provider answer is post-validated by `domain/memory` BEFORE any write —
outside the producer's trust boundary. Missing shape ⇒ `malformed-artifact`;
law-breaking values ⇒ `artifact-invalid`. Both classes are terminal for the job
(deterministic defects are never retried) and both bump the counters the
`ai-lanes` probe reports.

## Tier mapping (§6.11, verbatim)

high (≥ 0.85) = present normally · medium (0.60–0.85) = "suggested" affordance ·
low (< 0.60) = neutral heuristic frame — R7's contract constants, verbatim.
Boundaries belong to the higher tier; non-finite confidence collapses to low.
Surfaces bind affordances to tiers, never to numbers (R18; ownership is the
Memory layer alone, pinned by `scripts/isolation-lint.mjs` since E8-T02).
