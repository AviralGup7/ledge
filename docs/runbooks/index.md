# Runbooks (E7-T05) — failure playbooks, one per Blueprint §9 row

Every playbook follows the same arc: **Detect → Confirm → Act → Repair →
Drill**. Detections are observable (health probes, sweeps, e2e signals), never
vibes; repairs name exact lawful paths (rescue console acts, SOPs, port
laws). Read alongside `docs/degradation-matrix.md` (what the user sees while
you work) and `docs/threat-model.md` (what could be an attack instead of a
fault).

| §9 row            | playbook                                 | v1 status                             |
| ----------------- | ---------------------------------------- | ------------------------------------- |
| Journal           | [journal.md](journal.md)                 | active                                |
| Two-phase intents | [intents.md](intents.md)                 | active                                |
| Storage (IDB)     | [storage.md](storage.md)                 | active                                |
| Projections       | [projections.md](projections.md)         | active                                |
| Chrome adapters   | [chrome-adapters.md](chrome-adapters.md) | active                                |
| Offscreen         | [offscreen.md](offscreen.md)             | active (workroom shell; AI jobs v1.1) |
| AI providers      | [ai-providers.md](ai-providers.md)       | provision (ladder rung 1 = heuristic) |
| Search            | [search.md](search.md)                   | active                                |
| Importers         | [importers.md](importers.md)             | active                                |
| Exporters         | [exporters.md](exporters.md)             | active                                |
| Messaging/hub     | [messaging-hub.md](messaging-hub.md)     | active                                |
| Recovery engine   | `../recovery-runbook-v0.md`              | active (shipped with E2/E6)           |
| Sync (v2)         | [sync.md](sync.md)                       | future register (Tier 4)              |
| Diagnostics       | [diagnostics.md](diagnostics.md)         | active                                |

Ritual law: open one calm page per incident family, never a dashboard wall.
Support asks first for the diagnostics bundle (quiet page → rescue → scan
probes → export — redacted by default, the include-addresses flip is the
user's to make and decays on its own).
