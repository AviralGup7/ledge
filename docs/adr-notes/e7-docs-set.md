# E7-T05 · docs set (degradation matrix, threat model, runbooks, onboarding) — decision record

Milestone: EPIC E7 (RELIABILITY OPS), fifth work package. Roadmap row: "Docs
set | Degradation matrix, threat model, runbooks, 30-min onboarding |
per-subsystem | M | docs/ | Docs gate per milestone (§5)". Frozen anchors:
EES §7.6 (degradation matrix executed as tests; offline 100%), Blueprint §9
(14-row failure model — bootstrap law: one playbook per row), Blueprint §11
(security model), EES §7.5 (security/privacy gates), M2 docs/DoD grid (per-
subsystem docs column), PROJECT-BOOTSTRAP (README = 30-min onboarding law;
docs/runbooks/ planned venue).

No design forks escalated: content work under existing house law (bootstrap
already named venues; census pattern is established by FIXTURES/seeds/
checklist-sync).

## Shape decisions

- **Degradation matrix** (`docs/degradation-matrix.md`) — 24 D-rows across
  five tiers (engine/application/platform/import-export/AI-future). Every row
  names trigger/probe, user-visible honest behavior, recovery path, and an
  executable witness (or an explicit Tier/EPIC future marker — D23/D24 read as
  provisions, never as shipped). Grounded in EES §7.6 + Blueprint §9 fallback
  column + the E6 legacy-degrade laws.
- **Threat model** (`docs/threat-model.md`) — Blueprint §11 made operational:
  six trust boundaries (B1–B6), eight attacker classes (A–H incl. honest
  stance on local-profile reads and _self-inflicted_ diagnostics exfil, with
  the ADR-027/028 mitigations named), and a §7.5 gate census mapping each gate
  to its executable command. Future registers (sync relay, cloud depth-mode,
  Zone-1 indexing) explicitly marked.
- **Runbooks** (`docs/runbooks/`, index + 13 pages) — exactly one playbook per
  Blueprint §9 row (journal, intents, storage, projections, chrome-adapters,
  offscreen, ai-providers, search, importers, exporters, messaging-hub, sync,
  diagnostics) with recovery linking the pre-existing
  `docs/recovery-runbook-v0.md`. Uniform arc: Detect (real probe names from
  the §12 registry) → Confirm → Act (lawful paths only) → Repair → Drill
  (witness paths). ai-providers/sync pages are honest future registers.
- **Onboarding** (`README.md`) — scaffold-era status line corrected to the
  real milestone state; documents-map section added (governance, matrix,
  threat model, runbooks, a11y checklist, seeds, fixtures, ADR notes).
  The 30-minute law itself was already banked and stays.

## The docs gate is executable

The row's completion criterion ("docs gate per milestone") lands as
`ops/tests/unit/docs/docs-gate.test.ts` (28 proofs in the unit lane): §9-row
playbook completeness + index sync; every backticked repo path cited by the
set exists on disk (witnesses never rot); degradation rows always carry a
witness or a future marker; threat model names every §7.5 gate family and
only real pnpm scripts; README's `pnpm`/script claims resolve against
package.json and its `node scripts/*.mjs` claims resolve on disk. A doc edit
that breaks a citation fails `pnpm test` like any code red.

## Census note

Wire census untouched (30C/9Q/13S/17W/5S); zero source-code changes — docs +
census test only.
