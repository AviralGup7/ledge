# ADR note · E7-T02 — perf harness: committed baselines + refined R-10 regression thresholds

**Status:** accepted (recorded at E7-T02, M1 exit gate) · **Scope:** `ops/perf`, nightly perf job

## Context

Roadmap §risks **R-10** ("Perf regression unnoticed between harness runs") prescribes
mitigation "nightly perf compare vs baseline" with enforcement "block release on >10%
any-metric delta". EES §7.1 fixes absolute budgets (wake ≤200ms p95; park(100) durable
ack ≤500ms p95; append batch(20) ≤5ms p95; ingest ≤5ms/event amortized; tail scan
≤50ms; RTO ≤5s).

E7-T02 implements both — but a literal ">10% any-metric delta" on **wall-clock**
measurements is unsound on virtualized CI: run-to-run variance of a fixed workload on
shared runners routinely exceeds ±20% on sub-10ms latencies, which would make the lane
flaky-red on healthy code (the failure mode the constitution forbids: gates people
learn to ignore).

## Decision

1. **Baselines are committed source data** (`ops/tests/perf/baselines/perf-baseline.v2.json`),
   regenerated deliberately (`PERF_UPDATE_BASELINE=1 pnpm test:perf`) and reviewed in
   the diff that re-records them. Baseline rows exclude law-gated budget rows (those
   compare against the doc, never against history).
2. **Budget gates carry the literal EES §7.1 numbers.** Measured headroom at M1 is
   10–100×, so the literal budget is a _law_, not a threshold tuned day-to-day.
3. **R-10 is refined from "any 10% delta" to "meaningful regression"**: a failure
   verdict requires a relative blow-out AND an absolute one —
   - latency: `new p95 > max(baseline × 1.5, baseline + 2ms)` **(superseded → v2 below)**
   - throughput: `new rate < baseline × 0.6`
   - memory: `new mean > max(baseline × 1.25, baseline + 16MB)` **(superseded → v2 below)**

   A flat 10% wobble therefore never regresses; a 2.5× slowdown always does. The
   factors are env-overridable (`PERF_REGR_*`) without code change.

4. **Superlinear-growth gate:** per-element cost on the deterministic memory backend
   may grow ≤3× per scale decade (grid 100 → 50,000); findings fail the lane.
5. **Determinism evidence is inside the suite, not the report**: twin `readRange`
   digests and `rebuild ≡ driven` view digests throw on divergence — replay
   nondeterminism fails the lane by construction.

## Refinement v2 (same session, both entries measurement-driven)

### R2-Anti-flake: latency verdicts ride the MEDIAN (baseline schema v2)

Two consecutive identical-code runs on this profile regressed four rows against a
freshly recorded v1 baseline (`scan.full` 12.0→20.7ms, dexie `snapshots.restore`
30→91ms, boot memory +41MB ambient). Root cause: at the CI sample count (7), **p95 ≈
max — the most noise-sensitive statistic in the suite**. Decision:

- The latency **regression** statistic is the **median**; slack `2→4ms`; memory
  tolerances `×1.25/+16MB → ×1.5/+32MB` (both sized above measured jitter, with
  margin). Throughput unchanged (`< baseline × 0.6`).
- **p95 stays the doc-budget statistic** (budget rows measure what EES §7.1 says)
  and stays in every report row. The anti-flake move touches verdicts only.
- Baseline schema v1 → **v2**; v1 files load as absent by law (gated, not silently
  compared across statistics). A self-test locks the median law permanently.

### R2-Profile: 60-second house law + CI profile (default) vs reference profile (opt-in)

House rule declared at E7-T02: any single test exceeding 60s fails unless an exception
is declared. The default grid (memory 100/1000 + dexie 1000, 7 samples) lands at
~45s on a heavily loaded sandbox ⇒ ≪60s on CI. `PERF_GRID=full` +
`PERF_SUITE_TIMEOUT_MS=2400000` is the declared exception (reference profiling, not a
CI gate). Runtime budgets that fight this are tuned **with evidence only** —
`PERF_TRACE=1` prints per-family wall-clock; every cut below cites a trace:

- recovery iterations 8→3 (each iteration re-seeds and boots a seconds-scale
  reconcile; 1 warmup + 2 measured satisfy the RTO gate identically);
- ingest single-event loop cap 2000→200 (statistically plenty for a per-event
  latency distribution row; saved ~10–16s per dexie tier).

## Harness finding F-migration-cliff (recorded for E8-T15 + ADR-034 follow-ups)

While wall-clock tuning, the suite "hung" ~60s inside `runner.migrate()`.
Bisection (PERF_TRACE + standalone probes) isolated it exactly, with numbers:

- `db.putMany()` (5000 rows) inside a **versionchange upgrade transaction** on
  fake-indexeddb: **64.6s**; the identical write in a **normal** transaction: **0.3s**.
- Cost is **linear per secondary index**: at 3000 rows — `state`-only 6.9s,
  `lastActiveAt`-only 6.7s, `[state+lastActiveAt]`-only 7.0s, all three indexes 21.1s
  (≈ 2.3ms/row/index vs ~0.01ms/row/index normally; N=2000/5000 probes confirm ≥
  linear-row scaling). Store count is innocent (16 empty stores: 116ms).
- Row-count independence shown at N=500 (whole migrate 591ms), N=3000 above.

ADR-034's rollback law _pins_ migration transforms inside the versionchange
transaction, so this is a structural cost of the migration design on the reference
backend: CI measures the migration row at 500 rows; grid-scale evidence waits for
`PERF_GRID=full`. Open for E8-T15: (a) whether Chrome-real IDB shows the cliff
(platform-verification task), (b) migration design for large stores (e.g. chunked
backfill transforms behind the same version bump), (c) an upstream fake-indexeddb /
Dexie interaction report if it reproduces minimally.

## Consequences

- Nightly is the release-gating perf run (EES §8 unchanged: perf is _not_ PR-blocking).
- The report artifact (`ops/perf/out/perf-report.{json,md}`, 7-day CI retention) carries
  per-row baseline deltas — "historical comparison" evidence without flake noise.
- Re-recording a baseline is an explicit act of governance (diff-visible), never an
  automatic side effect of a green run.
- Chrome-real numbers (real IDB, real SW lifecycle) will attach at M2+ browser e2e;
  the harness's reference backends (memory adapter + fake-indexeddb Dexie) are the
  CI reference profile the EES budgets were written against ("CI-gated on reference
  hardware profile").
