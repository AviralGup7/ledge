# Playbook: AI providers (Blueprint §9 row 7) — provision register

**Status: future lanes.** v1 ships ladder rung 1 (heuristic naming/clustering,
ADR-018); providers, breakers, budgets, and lane shedding land in EPIC E8.
This page exists so the §9 row has a home; its laws are written to be enriched,
not replaced.

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

## Detect (v1.1)

- AI lane depths + breakers probe row; confidence-stamp audit trail.

## Current witnesses

- `src/infrastructure/ai/providers/heuristic/` (rung 1, confidence stamped).
- Probe registry reports the lane rows `unwired` — grey, by law, never green.

## Drill (Tier 3)

- Shadow-eval harness beats-heuristic threshold before any provider ships;
  AI-off e2e suite green at every gate.
