# Playbook: AI providers (Blueprint §9 row 7)

**Status: pipeline + three rungs live.** The durable job queue, lanes, leases,
breakers, ladder, and the exactly-once artifact commit (`docs/adr-notes/e8-ai-queue.md`)
carry the shipped ladder: rung 1 heuristic (E8-T01), rung 2 on-device WASM
(E8-T03, calibrated; E8-T04 summaries; E8-T05 briefs), rung 2/3 Chrome
built-in (E8-T06, generative catch-net at the 'suggested' stamp). Cloud
depth-mode stays the opt-in provision in `docs/ai-provider-matrix.md`. This
page's laws are written to be enriched, not replaced.

## Laws to carry forward (already frozen)

- Provider failure ⇒ circuit-break + next ladder rung; malformed output ⇒
  reject + count, never shipped with a straight face (Spec §6.1).
- Briefs **prefer absence**: low confidence renders neutral/heuristic, never
  a guess wearing a lab coat (Spec §5.13 honesty).
- Lanes: interactive > maintenance > background; background only in
  idle+battery-ok windows; cloud depth-mode is opt-in with per-day budgets
  and the ADR-018 redaction gateway (denylist params stripped, private-flag
  titles dropped).
- AI fully OFF ⇒ product stays coherent (Principle 29 gate): heuristic names,
  time clusters, keyword search.

## Detect (live since E8-T01)

- `ai-lanes` probe row: per-lane queue depths, breaker states, reject counters,
  workroom posture — wired, never grey where the AI graph is composed.
- Job rows are durable evidence (`ai_jobs` store): state, attempts, lease,
  failureClass — lanes shed by backoff, never silently.

## Current witnesses

- `src/infrastructure/ai/` — queue lanes + leases (`job-queue.ts`), breaker
  ladder (`ladder.ts`), worker hosts (`worker-hosts.ts`); rung 1 in
  `providers/heuristic/` (0.55 ⇒ R7 LOW ⇒ neutral frame), rung 2 in
  `providers/ondevice/` (calibrated stamps {0.88, 0.85, 0.72, 0.64}; yields
  never strike), rung 2/3 in `providers/builtin/` (0.60 MED-floor stamp —
  'suggested' forever; absence/download ⇒ invisible degrade).
- `src/application/usecases/ai-jobs.ts` — the exactly-once hinged commit owner
  (plus the E8-T05 silence classifier: done-and-silent for absence-preferred
  kinds, `silentDone` census in the probe fields).
- `ops/tests/unit/infrastructure/ai-queue.test.ts` (16) ·
  `ops/tests/unit/infrastructure/ai-jobs-service.test.ts` (13) ·
  `ops/tests/unit/infrastructure/ai-summaries.test.ts` (15) ·
  `ops/tests/unit/infrastructure/ai-briefs.test.ts` (20) ·
  `ops/tests/unit/infrastructure/ai-builtin.test.ts` (13) ·
  `ops/tests/chaos/ai-queue-kills.chaos.test.ts` (C1..C5 kill matrix) ·
  `ops/tests/property/ai-artifact-schema.property.test.ts` (10) ·
  `ops/tests/e2e/builtin-degrade.e2e.test.ts` (lane).

## Drill (Tier 3)

- Shadow-eval harness beats-heuristic threshold before any provider ships;
  AI-off e2e suite green at every gate.
