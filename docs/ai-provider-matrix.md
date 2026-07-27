# AI provider matrix (Blueprint §9 row 7) — v1 provisions

The ladder's legal rungs, in resolution order (elevated-first, heuristic last —
`PROVIDER_MATRIX_V = 1` in `src/infrastructure/ai/ladder.ts`). A rung ships only
when its witness column is green; everything below the shipped line is a
provision, not a promise. ADR-018's laws apply to every row: provider failure ⇒
circuit-break + next rung; malformed output ⇒ reject + count, never shipped;
cloud depth-mode is opt-in with per-day budgets and the redaction gateway.

| rung | provider id  | class                      | availability           | breaker            | status (E8-T01)                           | witness                                         |
| ---- | ------------ | -------------------------- | ---------------------- | ------------------ | ----------------------------------------- | ----------------------------------------------- |
| 3    | `clouddepth` | cloud depth-mode           | opt-in, budgeted/day   | opens at 3 strikes | **provision** — dir is a `.gitkeep` shell | E8 milestone rows (T03+)                        |
| 2    | `builtin`    | Chrome built-in AI         | capability-detected    | opens at 3 strikes | **provision** — dir is a `.gitkeep` shell | E8-T06 (absence = invisible degrade)            |
| 2    | `ondevice`   | WASM model in the workroom | capability-detected    | opens at 3 strikes | **provision** — dir is a `.gitkeep` shell | E8-T03 (shadow-eval must beat heuristic)        |
| 1    | `heuristic`  | `heuristic-domain-time-v1` | always (offline, free) | **never breaks**   | **shipped**                               | unit/property/chaos suites + S5 forced-rung law |

## Constants (versioned with the matrix)

- `BREAKER_OPEN_AT_FAILURES = 3`, `BREAKER_COOLDOWN_MS = 60_000`, half-open probe
  after cooldown (`src/infrastructure/ai/ladder.ts`).
- `HEURISTIC_NAMER_CONFIDENCE = 0.55` — §6.11 medium band → "suggested"
  affordance, never asserted (ADR-note F3 in `adr-notes/e8-ai-queue.md`).
- Lane deadlines: interactive 2.5s (EES §7.1 budget) · maintenance 30s ·
  background 2min (`AI_LANE_DEADLINE_MS`); lanes admit
  interactive > maintenance > background; background closed until a caller-proven
  idle+battery window exists (ADR-note F4).
- Job attempt accounting: `JOB_RETRY_CLAIMS = 3`, claim #4 runs
  `forceHeuristic`, failure there is `attempts-exhausted` — terminal, counted.

## Reject + count (Spec §6.1 / EES §2.12)

Every provider answer is post-validated by `domain/memory` BEFORE any write —
outside the producer's trust boundary. Missing shape ⇒ `malformed-artifact`;
law-breaking values ⇒ `artifact-invalid`. Both classes are terminal for the job
(deterministic defects are never retried) and both bump the counters the
`ai-lanes` probe reports.

## Tier mapping (§6.11, verbatim)

high (≥ 0.8) = present normally · medium (≥ 0.5) = "suggested" affordance ·
low = neutral heuristic frame. Boundaries belong to the higher tier; non-finite
confidence collapses to low. Surfaces bind affordances to tiers, never to
numbers.
