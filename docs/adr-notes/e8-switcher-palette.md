# E8-T09 · Switcher + command palette door — decision record

Milestone: EPIC E8 (INTELLIGENCE), ninth work package. Roadmap row: "E8-T09
Switcher + command palette door | Atomic park+switch (C28) | E4-T03/04,
E3-T06 | M | overlay palette | Atomicity chaos-tested". Frozen anchors: EES
C28 (SwitchMission v1.1: "per C5+C7 chain (atomic via single intent)"), Spec
W8 (ordering + modifier + failure law verbatim), Spec §9 ("one search engine,
two doors"), §9.6.13 park/undo ownership. Completion evidence: the chaos lane
kill-point matrix `ops/tests/chaos/switch-atomicity.chaos.test.ts` (K1–K6).

No design forks escalated: the row's criterion IS the design law. The
rulings below pin the chain economics and door mechanics the row left open.

## S-series rulings

- **S1 · Zero wire drift.** `SwitchMission` already sat frozen in the
  registry at v1.1 with exactly C28's payload (`parkCurrent:boolean;
targetMissionId:id`) from the wire-completeness wave — the milestone is
  behavior, not schema: application usecase + surface door + chaos law.
- **S2 · Phase cids (`<cid>:park`, `<cid>:resume`):** the intent re-cids its
  phases so a replayed tap replays the same ledger entries (§2.12 c-chain,
  K6-pinned). Park/resume services own their own idempotence downstream;
  the switcher owes them stable cids, nothing more.
- **S3 · Abort with the ORIGINAL fault; never a rollback.** Park failure ⇒
  the original error code plus `phase:'park', aborted:true` and resume
  never runs (W8, K1/K2). Resume failure ⇒ the original code plus
  `phase:'resume', parked:true` — an honest partial (K3/K4): the landed
  park is a lawful act, and undo — not exception plumbing — owns reversal
  (§9.6.13). A mid-chain cancellation throws the marker before the leap
  (K5).
- **S4 · An open target answers focus-truth, never a resume.** C7's
  precondition (PARKED/ARCHIVED) is never risked; picking a live mission
  returns `{outcome:'focus-window', windowId}` for the HOST to focus (the
  usecase reaches no chrome adapter — root law). `parkCurrent` still parks
  first when asked: the chain law is target-shaped, not target-gated.
- **S5 · Absence-check BEFORE state-read (the caught lie).** Rows'
  `missionStateOf` defaults a MISSING row to `'live'` (§2.9 forward
  tolerance) — which would have let a gone target answer a bogus
  focus-window. The usecase checks `undefined` first and answers
  `target-gone` (W6-pinned; caught by test, recorded so the pattern stays).
- **S6 · The W8 order is a domain law, not a render hint.**
  `src/domain/lifecycle/policies/switcher.ts`: open-first then parked-next,
  recency-desc inside each class, deterministic ties (name, then id);
  trash/unknown classes are classified OUT (the door never offers what
  resume would refuse).
- **S7 · The door is `>`-prefixed and seam-gated.** With the switcher seam
  present, `>` opens the §9 command scope and lists the switch verb; with
  the seam ABSENT, `>` behaves as ordinary search text (absence-by-default —
  a door that cannot act does not pretend). The v1 verb table deliberately
  holds exactly ONE verb: every listed verb works, today; §5.4's other
  verbs (park… / resume… / export… / merge…) join with the milestones that
  make them honest from an extension-page context.
- **S8 · W8's modifier is Alt+Enter, plumbed through the palette
  generically** (`PaletteMods.alt` on activation — clicks and Enter both).
  `parkCurrent`'s source window is the ROOT's to answer (the overlay page
  is not the user's window); the surface passes the boolean, composition
  supplies the coordinate.
- **S9 · Escape walks depth, not doors.** In the switcher, Escape steps
  back to the things scope; only the second Escape closes (two doors, two
  depths — a reflex layer never strands the user one keystroke deep).
- **S10 · Seam stays uncomposed until the v1.1 flip** (the J3/D9/N9
  reserve pattern): `SwitchMission` is dormant wire today (`unavailable-name`),
  so overlay-root leaves the seam absent in production and the door shut;
  tests inject it. The flip is a root-only change, provable by these tests
  re-run with the wire-backed seam.

## Boundaries explicitly NOT taken

- No fuzzy/powered ranking (§5.4's power layer is v1.2; the order is the
  spec's own).
- No multi-window switcher (source = one window; parkAll-switch is a C6
  chain and out of scope).
- No focus fallback when an open target's binding is stale (answers null;
  the host retries by re-derivation, not by guessing).
- No AI in the list (names are memory truth; the switcher adds nothing).
