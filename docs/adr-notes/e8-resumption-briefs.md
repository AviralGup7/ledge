# E8-T05 · resumption briefs (absence-preference terminal, dismiss memory, guardian card) — decision record

Milestone: EPIC E8 (AI lanes), fifth work package. Roadmap row: "E8-T05
Resumption briefs | W5 brief cards (dismiss memory) | E8-T04, E4-T04 | M |
guardian brief UI | Absence-preference law on low confidence". Frozen anchors:
Spec §6.9 (resumption brief: 2–3 sentences — state / where-you-stopped /
what's-pending; failure ⇒ NO brief, absence preferred to invention;
dismissible per-mission-forever), Spec §6.11 + EES-R18 (tier mapping law),
W5 (shown once, dismissibly, at window top), ADR-010/033 (wire append-only),
A-09 (registry row append law), ADR-041 (AI cannot mutate), EES §2.12
(exactly-once doctrine).

No design forks escalated: every ruling below is doc-law applied. Recorded
because absence-preference introduces a NEW terminal vocabulary ('silent')
and the dismiss wire rides the v1.1 reserve tier.

## J-series rulings

- **J1 · the 'silent' outcome class and its guard.** Hosts (SW-local and the
  workroom executor) answer `silent` — never `provider-error`, never
  `no-rung` — when every eligible rung answered a typed YIELD or no rung
  covers the kind, **iff** the kind is absence-preferred
  (`ABSENCE_PREFERRED_JOB_KINDS = ['mission-brief']` in the port; vocabulary,
  not a provider mood). A single breaker-worthy strike keeps the ordinary
  error ladder for all kinds. The SERVICE classifier re-verifies the kind at
  classification (defense in depth): a stray `silent` on a non-preferred kind
  is re-mapped to the provider-error release path — silence can never be
  smuggled onto a kind that owns an answer. The silence terminal is
  `queue.markSilentDone`: state `done`, **no hinge** (no event shares its
  fate — no artifact exists), **no rejection count** (absence is evidence,
  not a fault), row shape frozen. The ai-lanes probe derives the census
  (`stats.silentDone`) from the frozen shape: done ∧ no `artifactRef`.
- **J2 · briefs have NO heuristic rung by design.** Naming and summarizing
  have lawful shallow forms (counts, domains, time — the E8-T04 fail-down
  law). A "shallow brief" would be speculation worded like a memory; §6.9
  commands absence. The ladder resolves zero rungs for `mission-brief` on a
  heuristic-only graph, and J1 turns that into silence. Rung eligibility for
  briefs is therefore exactly the calibrated evidence path (on-device today;
  BuiltIn/CloudDepth later inherit the same silence terminal for free).
- **J3 · DismissBrief/GetMissionBrief ride the v1.1 reserve tier.** Both rows
  are registered now (frozen shape: command `{missionId, briefArtifactId?}`,
  query `{missionId}` ⇒ `{text?, presentation?}` — BOTH response fields absent
  is the lawful no-brief answer, not an error) so the surface contract
  freezes WITH the feature; the validator answers `unavailable-name` today
  (dormant by tier law, exactly like NudgeDismiss before it). The guardian
  therefore binds an INJECTED seam (`deps.briefs.{pending,onDismiss}`);
  composition defaults to absence, and flipping the tier is a one-line
  root change + dual-read window per ADR-033. Census test amended
  additively (30→31 commands, 9→10 queries).
- **J4 · dismiss is a PREFERENCE, never a deletion.** "Don't show again"
  commits `BriefDismissed{briefDismissalId, missionId, dismissedAt,
briefArtifactId?}` (producer Corrections; idempotentBy briefDismissalId —
  A-09 appended row, event census 31→32). The artifact row STANDS: memory,
  search and future projections keep their truth; only the brief card is
  suppressed. Two idempotence layers, both existing law: command redelivery
  dedupes at the intents ledger (cid law); distinct dismissal commands for
  one mission CONVERGE at projections keyed by missionId (the goal state is
  a set-membership fact). Contrast `MemoryArtifactInvalidated` — the
  correctness weapon for wrong artifacts; dismissing a TRUE artifact must not
  weaponize it.
- **J5 · the brief gate makes §6.11's low tier ABSENCE.** R18 is kept
  verbatim: `domain/memory/briefsGate` reads the tier word from
  `confidencePresentation` and never thresholds a number. Ordering law:
  dismissal outranks any artifact; then artifact absence; then shape
  totality; then tier. LOW ⇒ `absent` — for a brief the §6.11 "neutral
  transform" IS absence (J2 leaves no neutral form to wear). MEDIUM keeps
  the 'suggested' affordance (the card wears the chip; the surface binds the
  word, never the number).
- **J6 · G12 joins the shadow metric (append-only).** Every corpus row
  attempts a brief with a deterministic producer hint; the gate demands
  silence EXACTLY on evidence-thin rows and lawful cards elsewhere (≤420
  chars, hint verbatim, calm punctuation). Ship evidence: 532 written / 19
  silences / 0 violations across 551 rows — the absence-preference law made
  arithmetic at corpus scale (`docs/ai-shadow-eval-v1.md` amended in the
  same commit, per the metric freeze law).
- **J7 · two sentences is the floor, three the ceiling.** §6.9's shape is
  read as a law of sufficiency: the state sentence alone is the E8-T04
  one-liner restated, NOT a brief; a brief needs state + at least one of
  stopped/pending, and never more than the three sections. Hints ride
  verbatim (whitespace-collapsed, capped 200/200, word-boundary truncated
  under the 420 budget, never completed or adorned). A hint NEVER rescues
  thin evidence — calibration yields first (B4 pins this).

## Witnesses

- Host/ladder silence: `ops/tests/unit/infrastructure/ai-briefs.test.ts`
  A1–A6 (A4/A5 = the pump-level completion criterion: terminal done, zero
  `MemoryArtifactWritten`, `silentDone` census, breaker untouched; A6 = the
  stray-silent guard over the workroom wire).
- Provider honesty: B1–B6 (shape, verbatim, caps, budget, privacy,
  typed yields; replay-stable).
- Gate/dismiss/registry/wire: D1–D3, E1–E4, C1.
- Guardian: `ops/tests/unit/surfaces/guardian.test.ts` W5-1..W5-6 (window
  top, verbatim, single resume path, dismiss outranks seeds, sticky
  shown-once, §6.11 chip, absence-by-default incl. seam-fault calm degrade).
- Shadow eval: G12 (docs/ai-shadow-eval-v1.md + ops/shadow-eval/report.json).
