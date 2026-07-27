# Shadow eval (E8-T03) — metric set `ai-shadow-eval-v1`

The build gate that keeps the roadmap's completion sentence honest:
**OnDeviceML must beat the heuristic rung on the shadow corpus by a frozen
margin — in CI, on every PR, or it does not ship.**

Frozen definitions live in [`docs/ai-shadow-eval-v1.md`](../../docs/ai-shadow-eval-v1.md).
This directory is the machinery:

| path          | role                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `run.mjs`     | the gate (`pnpm check:shadow-eval`); `--write-report` refreshes evidence |
| `report.json` | committed evidence of the passing corpus run (a snapshot, not the gate)  |

Runner discipline (see header comment): the evaluator imports **nothing** from
`src/` — it re-implements the scorer from the frozen doc constants and audits
the shipped WASM machine against that law at corpus scale (G9). The unit lane
independently ties the runtime provider to the same law (M1–M4), so drift on
either side breaks a different gate.
