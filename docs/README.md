# docs/

- `governance/` — the seven LOCKED governing documents (read order is file-prefix order of creation; Constitution last, twice). Append-only; never edit in place.
- `adr-notes/` — milestone decision records (the "why" behind shipped rows; append-only, one file per work package).
- `runbooks/` — failure playbooks keyed to Blueprint §9 failure rows (each row = one runbook, E6/E7 era). Recovery's playbook predates the set: `recovery-runbook-v0.md`, linked from the runbook index.
- `permissions.md` — ADR-022 justifications (the install screen is the brand).
- `journal-segment-format-v1.md` — byte-level journal covenant (E2).
- `export-format-v1.md` — export covenant (E5-T04).
- `degradation-matrix.md` / `threat-model.md` / `beta-soak-matrix.md` — EES §7.6 / Blueprint §11 / E7 soak evidence.
- `accessibility-checklist.md` — the house a11y gate every surface PR answers.
- `ai-provider-matrix.md` / `ai-shadow-eval-v1.md` — E8 ladder posture + the frozen shadow-eval metric (metric changes land as ADR-noted events).
