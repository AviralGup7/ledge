# Ledge perf harness (E7-T02)

The Truth Engine's permanent measurement rig — the M1 perf gate and the machine that
notices every future slowdown. EES §8 class: **nightly + release-gating** (never PR).

## What it measures

| family      | rows                                                                                                                                 | doc law                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| journal     | append throughput + batch(20) latency · replay throughput + latency · scan.tail · scan.full · checkpoint · append memory peak/steady | batch(20) ≤ 5ms p95 (§7.1) · tail ≤ 50ms (§9/E2-T01 law) |
| projections | rebuild throughput per view · ingest apply (burst 500) amortized ms/event · rebuild ≡ driven determinism                             | ≤ 5ms/event (§7.1)                                       |
| snapshots   | generate · restore (+ journal↔store exactness probe)                                                                                 | —                                                        |
| lifecycle   | boot.cold · boot.warm · **wake** · intent ack · **park.ack(100)**                                                                    | wake ≤ 200ms p95 · park ack ≤ 500ms p95 (§7.1, M1 exit)  |
| maintenance | compaction · purge (+excluded-entries/s) · migration (dexie) · recovery.duration                                                     | RTO ≤ 5s (§7.8)                                          |
| storage     | raw IDB txn latency                                                                                                                  | —                                                        |
| ingest      | end-to-end single-event latency (append + apply)                                                                                     | —                                                        |

Replay determinism is a hard law inside the suite: twin `readRange` digests and
rebuild-vs-driven view digests must be identical or the suite throws (never a number).

## Running

```bash
pnpm test:perf                      # CI/nightly profile vs committed baseline (<60s by law)
PERF_GRID=full pnpm test:perf       # reference profile: 100/1k/10k/50k, 21 samples
PERF_GRID=full PERF_SUITE_TIMEOUT_MS=2400000 pnpm test:perf   # full grid on loaded hosts
PERF_SCALES=1000,10000 PERF_BACKENDS=memory pnpm test:perf
PERF_UPDATE_BASELINE=1 pnpm test:perf   # also: pnpm test:perf:update — re-record baseline
```

**House law**: the lane's single gate test must finish inside 60s or it fails. The
declared exception is `PERF_GRID=full` paired with `PERF_SUITE_TIMEOUT_MS` — a
minutes-long reference-hardware profile run, never the CI gate. The default profile
keeps every family and every law (budgets, regression compare, scaling, determinism
digest) while honoring the 60s law; grid-size evidence at 10k/50k is a profile run.

## Configuration (env)

`PERF_GRID` (`full` = reference grid · default = CI profile `100,1000` memory /
`1000` dexie, 7 samples, 1 warmup) · `PERF_SCALES` / `PERF_DEXIE_SCALES` /
`PERF_SAMPLES` / `PERF_WARMUP` explicit overrides · `PERF_BACKENDS` (`memory,dexie`)
· `PERF_UPDATE_BASELINE` · `PERF_REPORT_DIR` · `PERF_SUITE_TIMEOUT_MS` (60s-law
escape hatch for full-grid runs) · `PERF_REGR_*` threshold overrides ·
`PERF_SCALING_GROWTH_CAP`. The reference grid is `PERF_GRID=full`:
`100,1000,10000,50000` on memory, `1000,10000` on dexie, 21 samples, 3 warmups.

Workloads are **deterministic**: every corpus is a pure function of a seed
(`ops/perf/prng.ts` mulberry32), so a byte-equal journal is rebuilt on any host and
any regression verdict is about code, not input jitter. Journal/event/snapshot sizes
and projector populations are all knobs (`ops/perf/corpora.ts`, scenario sets).

## Baselines & regression policy

- Committed baseline: `ops/tests/perf/baselines/perf-baseline.v2.json` (serializer-owned;
  prettier-ignored). Re-record deliberately via `pnpm test:perf:update` and review the diff.
- `ops/perf/out/perf-report.{json,md}` — machine-readable + human report, uploaded as a
  CI artifact every nightly run (7-day retention).
- Meaningful-regression law (R-10 refined — see `docs/adr-notes/E7-T02-perf-harness-baselines-and-thresholds.md`):
  latency `median > max(baseline×1.5, baseline+4ms)` · throughput `< baseline×0.6` ·
  memory `> max(baseline×1.5, baseline+32MB)`. Budget rows never enter the baseline:
  they answer to the doc, not to history.
- **The latency regression statistic is the median** (baseline schema v2, measured):
  at the CI sample count, p95 ≈ max — and max jitter measured 3× between
  identical-code runs on shared runners. p95/p99 are still reported per row and
  still carry the doc-budget gates; the regression verdict rides the median.

## Design notes

- **Both adapters**: memory engine (deterministic reference; full grid + scaling law)
  and Dexie over fake-indexeddb (IDB-semantics reference; migration runner runs here).
- **Iteration budgets**: repeated sweeps cap total events per measurement
  (`APPEND_EVENT_BUDGET` et al.) so the 50k tier stays CI-feasible; replay/scan rows
  always measure a stream of _exactly_ the grid scale (separate pristine journal).
- **Noise discipline**: warmup iterations excluded; GC between memory phases
  (`--expose-gc` on the lane); forks pool + serialized files on the vitest project;
  statistics are median/p95, verdicts use the robust comparison statistic per kind.
- **`PERF_TRACE=1`** prints per-family wall-clock to stderr — the instrument that
  keeps 60s-law tuning measured, never blind.
- **Measured hardware-fiction caveat**: fake-indexeddb puts inside a Dexie
  _versionchange_ transaction cost ~2.3ms/row per secondary index (vs ~0.01ms in a
  normal txn) — ADR-034 pins migration transforms there by law, so the CI migration
  row measures 500 rows; grid-scale evidence is a `PERF_GRID=full` run. Details in
  the E7-T02 adr-note; Chrome-real behavior is M2+ browser verification.
- **Wall-clock is proxy hardware**: Chrome-real SW/IDъ numbers land with browser e2e
  at M2+; the row keys are stable so future backends slot in as new key prefixes.
