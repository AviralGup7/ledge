# Playbook: AI providers (Blueprint §9 row 7) — provision register

**Status: pipeline shipped (E8-T01), providers still rung-1.** The durable job
queue, lanes, leases, breakers, ladder, and the exactly-once artifact commit all
exist and are green (`docs/adr-notes/e8-ai-queue.md`); elevated providers stay
provisions tracked in `docs/ai-provider-matrix.md`. This page's laws are written
to be enriched, not replaced.

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
  `providers/heuristic/namer.ts` (confidence 0.55 stamped, suggested band).
- `src/application/usecases/ai-jobs.ts` — the exactly-once hinged commit owner.
- `ops/tests/unit/infrastructure/ai-queue.test.ts` (16) ·
  `ops/tests/unit/infrastructure/ai-jobs-service.test.ts` (13) ·
  `ops/tests/chaos/ai-queue-kills.chaos.test.ts` (C1..C5 kill matrix) ·
  `ops/tests/property/ai-artifact-schema.property.test.ts` (10).

## Drill (Tier 3)

- Shadow-eval harness beats-heuristic threshold before any provider ships;
  AI-off e2e suite green at every gate.
