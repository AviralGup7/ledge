# E8-T08 · Sprawl nudge + timing model — decision record

Milestone: EPIC E8 (INTELLIGENCE), eighth work package. Roadmap row: "E8-T08
Sprawl nudge + timing model | 1/day cap, dismiss memory (R15) | E4-T05, E6
counters | M | nudge engine | R15 bucket semantics fixtures". Frozen anchors:
Spec §5.8 ("one optional tab-sprawl nudge/day (opt-out; three dismissals =
never again per type)"), Spec §6.10 (inputs/output/failure/control — "timing
model errs to never"), EES-R15 (meta-bucket law, verbatim), M7-WP3 (the
`NudgeOffered (R15)` event), A-09 (append-only registry), the opt-in law.

No design forks escalated: the row's criterion IS the design law — the
R15 bucket-semantics fixtures (F1–F4 in `ops/tests/unit/application/
nudges.test.ts`) are the completion evidence. The rulings below pin the
carrier choices the row left to engineering.

## N-series rulings

- **N1 · The day is the device's local-midnight floor, host-computed.** R15
  freezes "counters in meta keyed by local-midnight bucket of device". The
  engine never reads `Date`: the composition root injects a minutes offset
  (`-getTimezoneOffset()`), `localMidnightFloor(ts, offset)` is pure, and
  F1–F4 pin IST/UTC/retreat/self-floor semantics — including that a tz
  change simply lengthens/shortens one day and NO correction logic runs.
- **N2 · Offers are journal truth; counters are meta (NudgeOffered).**
  M7-WP3 names the event. `NudgeOffered` (producer Policy, consumers
  NudgeModel/MemoryView, idempotentBy nudgeOfferId; dayBucket carried for
  audit) is the append-only fact that the surface spoke. The day-cap itself
  is a meta counter per R15 — journal events are not consulted for gating.
  (A-09 amendment: events census 32→33.)
- **N3 · Dismissal memory is a counter-PAIR in meta — no NudgeDismissed
  event.** R15 models dismissal memory per nudgeType; `{count,
lastDismissedAt}` implements §6.10 exactly (any dismissal inside 14 days
  suppresses; count ≥ 3 is forever), read-modify-write inside one meta txn.
  This is a deliberate split from E8-T05's `BriefDismissed` JOURNAL event
  (J4: a brief dismissal is per-mission preference truth the memory gates
  read) and E8-T07's settings-carrier dupe ignore (D5: widget relief). A
  nudge dismissal is neither: it is two numbers with the exact §6.10 shape.
  If a later milestone wants dismissal analytics it adds the event
  append-only (A-09) — the pair remains the gate's truth.
- **N4 · Meta-first, event-second: a failed audit CONSUMES the day.** The
  offer path writes the day row before committing `NudgeOffered`. Ordered
  event-first, an event-then-meta crash would double-offer the same day
  (new offerId, no dedupe); ordered meta-first, the worst failure is the
  day slot burning with nothing rendered. §6.10 says the model errs to
  never — so the failure boat points at silence, mechanically.
- **N5 · Sticky within the day: a re-render is the same whisper.** The
  day's meta row carries the offer itself; a same-day re-pull re-answers
  the SAME offerId (no counter bump, no second event) while the stale
  cohort still clears the floor — otherwise a guardian re-render would
  blink the card (first render spends the cap) or double-speak. Dismissal
  outranks stickiness (the user already answered); a dissolved cohort
  outranks it too (the user already tidied — the whisper is moot).
- **N6 · Evidence v1 is strip pressure ONLY, at the spec's own number.**
  §6.10 lists rhythms and dormancy as inputs; shipping rhythm-learning
  before the whisper proves its manners would invert "ship quiet first,
  then whisper" (Spec v1.1 lane note). Staleness is a fact
  (`lastActiveAt` strictly before `now − 7d`, the "from last week"
  phrasing); age-0 rows are excluded (a nudge never claims age it cannot
  show); the floor is 6 — the spec example's own cohort size.
- **N7 · Control switches read as mute-only-on-explicit-false.** The
  global "no suggestions" switch (`prefs.suggestions.all`) and the
  per-capability nudge toggle (`prefs.suggestions.nudges`) mute only when
  explicitly false — §5.8 makes the whisper opt-OUT by design, and
  crash-recovery never reads either (it is a promise, not a suggestion).
- **N8 · Park is the gesture; acting re-derives and converges.** The tap
  re-derives the cohort from a fresh read (act-on-now), parks oldest-first
  with per-tab checkpointed cids, tolerates `E_NOT_FOUND_TAB` as converged
  (A8), and surfaces any other fault honestly with partial state standing.
  An already-tidy strip converges to "nothing left" — not an error.
- **N9 · v1.1 wire reserved dormant.** `DismissSprawlNudge` +
  `GetPendingNudge` join the reserve family (J3/D9 precedent) at census
  34 cmd/12 q; today the guardian rides the injected application seam.
- **N10 · One card, hygiene-cluster placement.** The slot sits between the
  dupe strip and the open-tab inventory it relieves; a seam fault, a null
  offer, or no seam all render nothing — the one-a-day slot never becomes
  noise (N4 guardian tests).

## Boundaries explicitly NOT taken

- No rhythm/time-of-day learning (that is §6.10's later input set, gated
  by its own milestone and the NudgeModel consumer already reserved).
- No cross-type nudges (only 'sprawl' exists; the dismissal memory is
  keyed per nudgeType so a second type needs no schema change).
- No janitor for stale `nudge.day.*` rows (a row is ~80 bytes; the meta
  store's sweep economics can absorb them — revisit if probes say otherwise).
- No morning-card ranking (that is E8-T12's W9 card, which will READ the
  same R15 clocks but owns its own gate).
