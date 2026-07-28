# E8-T06 · BuiltIn adapter (capability-detected) — decision record

Milestone: EPIC E8 (AI lanes), sixth work package. Roadmap row: "E8-T06
BuiltIn adapter (capability-detected) | Chrome built-in AI path | E8-T03 | M
| providers/builtin | Absence = invisible degrade (e2e)". Frozen anchors:
ADR-018 ladder (heuristic → OnDeviceML → BuiltIn → CloudDepth), §5.13
honesty law, §6.11/R7/R18 tier law, E8-T05 J2 (absence preference), the
right-to-disappear doctrine (no ambient downloads, no banners).

No design forks escalated: the row's criterion IS the design law; the
rulings below pin calibration posture and fault taxonomy, which the row
left to engineering.

## K-series rulings

- **K1 · 'downloadable' IS absent.** Chrome's availability vocabulary
  (both generations — 'readily'/'available' vs 'no'/'after-download'/
  'downloadable'/'downloading') reduces to three postures: ready,
  downloadable, absent. Only `ready` registers the rung. Triggering a
  gigabyte on-device model pull because a tab manager asked for a name
  would violate the quiet posture; downloading joins on re-detection at a
  later mount, never by polling, never by a session create "to see".
- **K2 · uncalibrated output stamps the MED floor, forever.**
  `BUILTIN_CONFIDENCE = 0.6` — exactly the §6.11 MEDIUM floor ⇒ every
  BuiltIn answer wears the 'suggested' affordance and can never present as
  authoritative (HIGH) or be wasted as neutral (LOW). This is a policy
  constant with the same register class as `HEURISTIC_NAMER_CONFIDENCE` —
  pinned in the matrix, changeable only with an ADR note. Generative
  answers have no logits; pretending to a calibrated number would be the
  exact lab-coat lie §5.13 bans.
- **K3 · detection is per-mount, single-flight, and total.** The deferred
  rung memoizes one availability read; a rejecting API or an unknown word
  reads as absent; the async factory answers null on anything but ready.
- **K4 · shape transgressions are yields; API faults are provider-errors.**
  A sanitized-then-refused answer (empty, placeholder word, instruction
  echo, urgency-only) is EVIDENCE quality ⇒ typed yield (no breaker
  strike, ladder falls to heuristic). `create()`/`prompt()` rejecting is a
  PROVIDER condition ⇒ `E_PROVIDER_DOWN` (ordinary retry economics).
  Sanitation is total: first line, unwrapped (quotes/backticks/bullets),
  urgency marks stripped, whitespace collapsed, word-capped (6-word ask /
  12-word cap for names; 18-word ask+cap and the §6.3 120-char budget for
  summaries). A previewed lie never ships.
- **K5 · documented-context only.** `LanguageModel` is a document global —
  the rung registers in the workroom executor (offscreen-root) behind the
  on-device rung and above heuristic; bg-root's SW-local ladder stays
  on-device → heuristic (the model is stateless bytes and SW-legal;
  LanguageModel is not). Host fallthrough (§9 row 6) routes around the
  workroom when it dies, degrading to the SW-local ladder exactly as
  before — the rung's absence in one host is invisible in the other.
- **K6 · briefs remain absent here (E8-T05 J2 verbatim).** Capabilities are
  `['mission-name', 'mission-summary']` only. An uncalibrated generative
  brief is speculation wearing a memory's clothes; `mission-brief` resolves
  zero rungs in this provider and the E8-T05 silence terminal stands.
- **K7 · session per job, always destroyed.** No ambient session state
  across missions (identity-class hygiene); `destroy()` is best-effort in a
  finally — a wedged teardown is not evidence of anything.
- **K8 · prompt corpus law is the lexicon's.** Titles always contribute; a
  discarded tab contributes its title and NEVER its domain; with no tab
  rows the domain list itself is the evidence (one privacy vocabulary
  across every rung, U7 pins it). All prompt content is on-device by
  platform law — zero egress holds.

## Completion evidence ("absence = invisible degrade (e2e)")

Three levels, each runnable:

1. `ops/tests/unit/infrastructure/ai-builtin.test.ts` U1–U3 — every
   absence class (missing API, 'no', 'unavailable', unknown words,
   rejecting availability, and all three download postures) ⇒ null factory
   / absent-typed yield; `create` never called (proven by call counts).
2. Same file L1 — pipeline level: absent deferred rung + heuristic in a
   real host ⇒ the job completes with the honest frame, breaker cell
   closed at 0, the rung visible-as-evidence only.
3. `ops/tests/e2e/builtin-degrade.e2e.test.ts` — real Chromium, real
   ParkWindow: coherent name on the mission, zero `[role=alert]`, ai-lanes
   probe spotless (0 failed / 0 rejected / no open breakers). Declared
   long-running; e2e lane only.
