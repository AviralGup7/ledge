# E8-T02 · Isolation lint + confidence gates — decision record

Roadmap row: "E8-T02 Isolation lint + confidence gates | ADR-041 build law +
tier mapping (R7/R18) | E8-T01, E1-T13 | M | CI rules + policy | Mutation-symbol
import impossible (fixture fails)". State: **shipped** — the gate is
`scripts/isolation-lint.mjs`, wired as `pnpm check:isolation` into `ci:all` and
the PR workflow (fast, PR-blocking, dependency-free source scan).

---

## G1 — AI module isolation made mechanical (ADR-041)

**Decision.** The constitutional law ("the `infrastructure/ai/` package and
`domain/memory` compile without imports of any mutation-capable port") is now
enforced by a source scan, layered under (never instead of) the depcruise
`ai-cannot-mutate` rule: inside `src/infrastructure/ai/**` and
`src/domain/memory/**`, any import of the tabs/windows/tab-groups ports, the
`infrastructure/chrome` verb adapters, the journal append path,
surfaces/roots/.wxt layers, any import _naming_ a mutation-port type
(`TabsPort|WindowsPort|TabGroupsPort`), or any touch of the ambient `chrome`
object is a hard violation.

**Why a second gate on top of depcruise.** The depcruise rule bans _paths_; the
completion criterion demanded the proof form "mutation-symbol import impossible
(fixture fails)" — a statement about the GATE, not the code: planted hostile
fixtures (`ops/fixtures/lint/*.fixture.ts`, each carrying a
`// lint-fixture: <virtual src path>` header) are evaluated with identical rules
and MUST yield findings. A fixture the gate passes silently fails CI — the gate
can never rot into a no-op without going red. Sanctioned seams are enumerated in
the script's heading (OffscreenPort as the sandbox's own lifecycle;
StorageEnginePort scoped to `ai_jobs` per E8-T01 F1) — everything else in the
scope is compute + read-only output types, exactly as ADR-041 demands.

## G2 — tier ownership (R18) as a lint, not a review wish

**Decision.** Outside `src/domain/memory/**` (tests exempt — they PIN the law):
importing the raw cutoffs (`CONFIDENCE_TIER_HIGH_AT/MEDIUM_AT`) is banned, and
so is numeric confidence thresholding (`confidence >= 0.x` shapes). Consumers
bind the Memory layer's pre-mapped tier/presentation (`confidenceTier`,
`confidencePresentation`, `presentationForTier`, the `ConfidenceTier` wire
vocabulary); surfaces never hold threshold logic, keeping confidence law
single-sourced (R18 verbatim). Comment prose is blanked before scanning —
law-stating documentation is not threshold logic.

## G3 — R7 constants pinned at the contract values

**Decision.** EES R7 froze the tier cutoffs: **HIGH ≥ 0.85 · MED 0.60–0.85 ·
LOW < 0.60**. E8-T01 had shipped provisional 0.80/0.50 (recorded in
`e8-ai-queue.md` F3); E8-T02 aligns to R7 verbatim and pins the values
mechanically — any drift in `confidence.ts` fails the gate until this pin AND
an ADR note move together (R7's own law: tunable until Tier-3 freeze, then
docs-visible only). The R7 consequence: the rung-1 honest label's 0.55 stamp is
the LOW band ⇒ §6.11's neutral heuristic frame. Shallow truth never borrows the
suggestion affordance (§5.13); raising the stamp to buy one would be the exact
dishonesty the scale exists to prevent.

## Tests / evidence

- `node scripts/isolation-lint.mjs` — green on the tree; 2/2 hostile fixtures
  provably caught (mutation import ⇒ 3 findings; threshold logic ⇒ 2 findings).
- Tier-law suites re-pinned at R7: `src/domain/memory/memory.test.ts`,
  `ops/tests/property/ai-artifact-schema.property.test.ts` (0.55 ⇒ low/neutral).
