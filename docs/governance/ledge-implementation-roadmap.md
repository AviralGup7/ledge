# LEDGE — MASTER IMPLEMENTATION ROADMAP
**Phase 6 · Execution Plan · v1.0**
**Governing documents (locked):** Vision → Specification → ADR → Blueprint → Engineering Execution Specification (EES).
**Using this document:** Task IDs (`E#-T##`) are stable forever. Complexity: **S** ≤1 eng-day · **M** 2–3d · **L** 4–6d · **XL** 7–10d. Owner *slots* (not people): **P**=Platform · **X**=Experience · **Q**=Quality · **D**=Docs — sized for 1–3 senior engineers; durations are planning ranges, not commitments. Every "Completion criteria" below cites EES gates; nothing here overrides locked documents.

---

# SECTION 1 — PROJECT BREAKDOWN

## EPIC E1 — FOUNDATIONS (Tier 0)
| Task | Purpose | Deps | Cmplx | Blocking | Deliverables | Completion criteria |
|---|---|---|---|---|---|---|
| E1-T01 Repo + build toolchain | WXT-class build, manifest gen, TS strict, paths (ADR-036/037) | — | M | All | `ledge/` skeleton, build passes | Chromium manifest builds&loads unpacked |
| E1-T02 Permission manifest | Exact ADR-022 set + justifications doc | T01 | S | E3, store | `manifest/` + docs/permissions.md | Diff-review signage; no extra perms |
| E1-T03 Dependency law CI | dep-cruiser rules (Blue §4), bundle budgets, egress-guard ∅ | T01 | M | E9 gates | ci/ rules + failing fixtures | Deliberate violations fail build |
| E1-T04 Identity module | ULIDs, deviceId provisioning (EES §2.1) | T01 | S | E2-T03 | shared-kernel/identity | Golden-table tests green |
| E1-T05 HLC clock | Hybrid logical clock (EES §2.2) | T04 | M | E2-T03 | shared-kernel/clock + tests | Property suite (merge/advance) green |
| E1-T06 Canon module | URL canonicalization + denylist (ADR-016) | T01 | M | E2, E5, E8 | shared-kernel/canon + golden corpus | Idempotence property green |
| E1-T07 Event registry v1 | 26-type catalog + upcaster skeleton (EES §4) | T05 | M | E2-T03 | shared-kernel/events | Registry fixtures; upcast golden tests |
| E1-T08 Result/Error taxonomy | Typed errors + copy-key mapping (ADR-026) | T01 | S | All surfaces | shared-kernel/result | No-unmapped-error lint passes |
| E1-T09 Storage adapter skeleton | Dexie wrapper, schema v1 stores, meta (EES §5) | T01 | M | E2-T04 | infrastructure/storage | Contract-suite skeleton runs |
| E1-T10 Journal appender core | append + readRange (no CRC yet) (EES §2.8) | T09 | M | E2-T03 | infrastructure/journal/core | Append→read round trip in CI |
| E1-T11 Message contracts v1 | Envelope, validators, handshake, registry (EES §3.1) | T01 | M | All contexts | application/contracts | Fuzz zero-crash; unknown-name ignore law |
| E1-T12 Composition roots | bg/offscreen/page roots + manual DI (ADR-025) | T01 | S | All | roots/ | Contexts boot with stub adapters |
| E1-T13 CI pipeline | PR gates wired (unit, lint kings, dep law, bundle) | T03, T01 | M | All releases | ops/ci | Dummy PR shows full gate run |
| E1-T14 Copy catalog + calm-copy lint | All strings externalized; Principle 22 lexicon CI | T01 | S | E4 | surfaces/components/copy | Inline-literal lint green; exclamation lint green |

## EPIC E2 — TRUTH PIPELINE (Tier 1)
| Task | Purpose | Deps | Cmplx | Blocking | Deliverables | Completion criteria |
|---|---|---|---|---|---|---|
| E2-T01 Journal full (segments, CRC32, sealing, checkpoints) | Durable truth per ADR-004 | E1-T10 | L | E2-T03, E6 | journal appender+scanner | CRC walk detects seeded bit-flips |
| E2-T02 Intent ledger + two-phase executor | snapshot-before-close machine (ADR-011, EES-R1/R2) | E2-T01 | L | E3-T05, E4 park | intents store + executor | Chaos: kill pre/post every txn ⇒ 0 loss |
| E2-T03 Event→Projection engine | Projectors, watermarks, delta publisher (EES §2.10) | E1-T07, E1-T09 | L | E4, E5 | infrastructure/projections | Determinism property: same journal⇒same models |
| E2-T04 Storage schema v1 + migrations | All 15 stores + migration runner (EES §5) | E1-T09 | L | E2-T03 | storage/schema + migrations | N-1→N fixtures; unknown-field round-trip |
| E2-T05 Ingest pipeline | Tab/window/group observations → events (EES §5.3) | E3 adapters, E2-T03 | L | E4 | chrome/adapters → hub ingest | Batch law (20/50ms) verified; ≤5ms/event |
| E2-T06 Boot reconciler | Dangling-intent resolution, conservative law (EES §2.13) | E2-T02 | M | E6 recovery | recovery/reconciler | Every kill-point fixture resolves correctly |
| E2-T07 Crash marker + BootReport | storage.session semantics + report schema (EES-R16) | E2-T06 | M | E6 | recovery/marker | Update-vs-crash disambiguation on fixtures |
| E2-T08 Snapshot system | chunked snapshots w/ group styles (EES-R4/R5) | E2-T02 | M | E4 restore | sessions store + builders | 500/part chunking; style fidelity fixture |
| E2-T09 Chaos harness v1 | Kill-point driver, fault injection (EES §8) | E2-T02, E2-T06 | L | Gates | ops/chaos | points.txt enumerated; suite runs CI |
| E2-T10 Property suites | Replay invariants, purge-law byte-absence (EES §8) | E2-T01..T04 | L | Gates | ops/tests/property | 1k seeds CI green; purge bytes absent |
| E2-T11 Journal compaction + purge exclusion | Physical rewrite law (ADR-020) | E2-T01, E2-T04 | XL | Trash purge | journal/compact | Property: purged bytes physically absent |

## EPIC E3 — BROWSER ADAPTERS (Tier 1)
| Task | Purpose | Deps | Cmplx | Blocking | Deliverables | Completion criteria |
|---|---|---|---|---|---|---|
| E3-T01 Tabs/Windows adapters | EES §6 behavior contracts | E1-T01 | L | E2-T05, E4 | chrome/tabs, chrome/windows | Contract suite green on stable+beta |
| E3-T02 TabGroups adapter | Style fidelity create/update (EES-R4) | E3-T01 | M | E2-T08 | chrome/tabgroups | Degrade-ok path tested |
| E3-T03 NativeSessions adapter | Recovery cross-check reads (read-only law) | E3-T01 | S | E6 | chrome/nativesessions | Contract suite; gap-degrade logged |
| E3-T04 Runtime/Alarms/Idle adapters | Lifecycle, maintenance windows, battery signals | E3-T01 | M | E2-T06, E7 | chrome/runtime, alarms, idle | Top-level sync registration verified (MV3 lint) |
| E3-T05 Command durability integration | Ingest↔intent hinge, race-tolerant removals (EES-R2) | E2-T02, E3-T01 | M | E4 | adapter race handling | R2 race fixture green |
| E3-T06 Commands/ContextMenus adapters | Keyboard map + conflict audit + menus (EES §6) | E4 surfaces | M | E4-G1 | chrome/commands, contextmenus | Conflict-reassign user-note flow |
| E3-T07 OffscreenPort + workroom skeleton | Reason resolution, spawn/close, heartbeat lease | E3-T04 | M | E5, E7 | chrome/offscreen + workroom page | Spawn ≤300ms; enum-drift soak on beta |
| E3-T08 StorageArea/Favicon/Permissions adapters | Markers, icons, runtime-optional flow | E3-T01 | S | E2-T06, E4 | those adapters | Session-marker semantics fixture |

## EPIC E4 — MVP EXPERIENCE (Tier 2)
| Task | Purpose | Deps | Cmplx | Blocking | Deliverables | Completion criteria |
|---|---|---|---|---|---|---|
| E4-T01 Domain deciders + policies | All MVP transitions + inverse atoms (EES §2.5) | E2-T03 | L | E4 use cases | domain/lifecycle | Invariant matrix 100% green |
| E4-T02 Mission/tabs read models | MissionsView/TabsView/Archive projectors | E2-T03 | M | E4 surfaces | projections for views | Determinism verified |
| E4-T03 Park use cases (4 granularities) | C3–C6 end-to-end w/ honest pending (EES-R1) | E2-T02, E4-T01 | L | E4-G1 | usecases/park | Ack/Applied states exact; heartbeat post-Applied |
| E4-T04 Resume use cases | C7/C8 + group-style restore + move notes (R3/R4) | E4-T03 | L | E4-G1 | usecases/resume | 30-tab resume ≤ budgets; style fixture |
| E4-T05 Guardian surface | Park gestures, heartbeat, start/resume, empty states (Spec §5) | E3-T06, E4-T03 | L | Dogfood | surfaces/guardian | A11y core green; catalog-only strings |
| E4-T06 Quiet page v1 | Missions, Recently Closed, Trash views + paging | E4-T02 | L | M5 rescue | surfaces/quiet-page | FCR ≤300ms @1k; virtualized lists |
| E4-T07 Recently Closed + retention sweeps | View + sweeper + setting (EES §5) | E4-T06 | M | — | recently_closed + alarms job | Retention matrix fixtures (7/30/90) |
| E4-T08 Undo stack + Trash | Persisted stack (20), inverse atoms (EES-R9) | E4-T01, E4-T06 | M | — | usecases/undo, trash | R9 no-auto-retry; conflict path shown |
| E4-T09 Delete flows + bulk confirm | C15 thresholds, sweeper interplay (R14) | E4-T08 | M | — | usecases/delete | >20 confirm gate; sweeper serialization |
| E4-T10 Overlay reflex search v1 | ⌘⇧K UX + keyword path + scope widen (Spec W6) | E5-T01, E3-T06 | L | — | surfaces/overlay | p95 ≤100ms @10k; widen copy exact |
| E4-T11 First-run ingest (W1) | Draft clusters (heuristic), 60-second relief sequence | E4-T03, E8-T01 | M | Public demos | usecases/firstRun | Zero-config; heuristic naming fallback |
| E4-T12 Heuristic naming/clustering provider | Ladder rung 1 (no ML) (ADR-018) | E1-T06, E4-T11 | M | E7 | infrastructure/ai/providers/heuristic | Fallback labels honest; confidence stamped |

## EPIC E5 — SEARCH & PORTABILITY (Tier 2)
| Task | Purpose | Deps | Cmplx | Blocking | Deliverables | Completion criteria |
|---|---|---|---|---|---|---|
| E5-T01 Search index + ranker | Tokenizer (unicode/CJK-bigram), BM25-lite, freshness law (EES §2.11) | E2-T03, E1-T06 | XL | E4-T10 | infrastructure/search | Lag-fallback correctness; CJK recall goldens |
| E5-T02 Dupe detection v1 (canon + Jaccard markers) | W11 markers/whispers (informational only, R17) | E5-T01, E4-T05 | M | v1.1 | dupe_index + markers | FP ≤2% crafted corpus |
| E5-T03 Exporters (json/html/md) | Streamed, chunk-verify (ADR-045, EES §2.14) | E4 use cases | L | E5 imports (round-trip) | infrastructure/exporters | No-silent-partial; 100k stream ≤60s |
| E5-T04 Export-format spec doc | Public covenant v1 (ADR-038/045) | E5-T03 | M | Store listing | docs/export-format-v1.md | Versioned, examples validated |
| E5-T05 Importers (3 parsers) | OneTab, SessionBuddy, Netscape; two-phase commit (EES-R11) | E5-T03, E3-T07 | XL | Beta acquisition | infrastructure/importers | R11 batch undo legal only on complete; rejects file |
| E5-T06 Import preview UI | Counts/dupes/rejects display w/ commit flow | E5-T05, E4-T06 | M | — | quiet-page import panel | Preview <2s typical; corrupt-abort path |

## EPIC E6 — RECOVERY, DIAGNOSTICS, RESCUE (Tier 2)
| Task | Purpose | Deps | Cmplx | Blocking | Deliverables | Completion criteria |
|---|---|---|---|---|---|---|
| E6-T01 W7 recovery flow + card gating | Recovery card on loss-risk only (Blue §14.4) | E2-T07, E4-T06 | L | Public beta | recovery card + flow | Real-restart e2e; exact catalog copy |
| E6-T02 Sessions cross-check UI | chrome.sessions reconcile candidates | E3-T03, E6-T01 | M | — | recovery crosscheck panel | Confirm-before-restore law |
| E6-T03 Diagnostics core | Ring buffer, redactor, probes registry (EES §2.15) | E2-T03 | M | E6-T04 | infrastructure/diagnostics | Redactor-fail-drop proof |
| E6-T04 Rescue console | Health probes UI, repair actions (rebuild/scan) | E6-T03, E4-T06, E2-T09 | M | M5 | quiet-page rescue | Probe catalog complete per EES §12 |
| E6-T05 Diagnostics export | Bundle assembly, include-flip auto-decay | E6-T03 | S | Support | usecases/diagExport | ≤10s; decay fixture |
| E6-T06 Integrity scanner UI hooks | Tail/full scans w/ C24 rate law | E2-T01, E6-T04 | S | — | rescue actions | Full-scan cadence enforced |

## EPIC E7 — RELIABILITY OPS (threaded through tiers)
| Task | Purpose | Deps | Cmplx | Deliverables | Completion criteria |
|---|---|---|---|---|---|
| E7-T01 Fixture corpus | Real OneTab/SessionBuddy/bookmarks exports + synthetic 10k/50k/200k corpora (audit A3) | E1 | L (content work) | ops/fixtures | Corpus licensing/privacy clean; generators deterministic |
| E7-T02 Perf harness | Budget gates §7.1–7.3 on reference profile | E1-T13 | L | ops/perf | Baselines recorded; regression compare in CI |
| E7-T03 A11y suite + checklist | §7.4 zero-defect program | E4 start | M | ops/tests/a11y + checklist | Every surface passes at its milestone gate |
| E7-T04 Regression seed corpus | Bug→test-first pipeline discipline | M2 | S (ongoing) | seeds/ | Every field bug lands a seed pre-fix |
| E7-T05 Docs set | Degradation matrix, threat model, runbooks, 30-min onboarding | per-subsystem | M | docs/ | Docs gate per milestone (§5) |
| E7-T06 Chrome beta-channel soak | Beta-channel CI lane + monthly manual matrix | E1-T13 | S (ongoing) | ci lane | Beta job red ⇒ named owner within 48h |

## EPIC E8 — INTELLIGENCE (Tier 3 → v1.1/v1.2)
| Task | Purpose | Deps | Cmplx | Deliverables | Completion criteria |
|---|---|---|---|---|---|
| E8-T01 AI job queue + lanes + leases | Durable jobs, exact-once artifacts (EES §2.12) | E2-T04, E3-T07 | L | infrastructure/ai | Offscreen-kill exactly-once proof |
| E8-T02 Isolation lint + confidence gates | ADR-041 build law + tier mapping (R7/R18) | E8-T01, E1-T13 | M | CI rules + policy | Mutation-symbol import impossible (fixture fails) |
| E8-T03 OnDeviceML provider (naming) | WASM model in workroom, shadow-eval harness | E8-T01 | XL | providers/ondevice | Beats heuristic ≥ threshold on shadow corpus |
| E8-T04 Summaries v1 (park-time one-liner + thread) | Spec §6.3 artifacts | E8-T03 | L | summarizer binding | Fail-down law: heuristic when low-fidelity |
| E8-T05 Resumption briefs | W5 brief cards (dismiss memory) | E8-T04, E4-T04 | M | guardian brief UI | Absence-preference law on low confidence |
| E8-T06 BuiltIn adapter (capability-detected) | Chrome built-in AI path | E8-T03 | M | providers/builtin | Absence = invisible degrade (e2e) |
| E8-T07 Dupe detection v2 + actions | Markers→one-tap actions (opt-in law) | E5-T02 | M | guardian dupe strip | No silent closing (spec) — action tests |
| E8-T08 Sprawl nudge + timing model | 1/day cap, dismiss memory (R15) | E4-T05, E6 counters | M | nudge engine | R15 bucket semantics fixtures |
| E8-T09 Switcher + command palette door | Atomic park+switch (C28) | E4-T03/04, E3-T06 | M | overlay palette | Atomicity chaos-tested |
| E8-T10 Conclude flow + outcome notes | W12 with note + badge | E4-T06 | S | conclude UI | Archive badge + export includes notes |
| E8-T11 Topics chips | AI topics → chips + correction (Spec §3.6) | E8-T03 | M | topics projections | Correctable; retrieval joins (R12) |
| E8-T12 Morning resume card | W9 session-start card, 3-mission cap | E8-T05 | M | guardian card | Silent-absence law verified |
| E8-T13 Delta ring + projector checkpoints | Fan-out efficiency (Blue §14.2) | E2-T03 | M | delta_ring + checkpoints | Gap-rate drop measured |
| E8-T14 Semantic embeddings spike → provider | Ledge+-ready rank source behind flag (R6 law: no chrome.history) | E8-T03 | XL | embedder provider (flag-off) | Rank compose w/ keyword; killswitch to demo |
| E8-T15 50k-corpus hardening | Perf tier-2 fixes from harness deltas | E7-T02 | L | various | §7.1 budgets hold @50k |

## EPIC E9 — v2 BOUNDARIES (Tier 4 — proofs, not features)
| Task | Purpose | Deps | Cmplx | Deliverables | Completion criteria |
|---|---|---|---|---|---|
| E9-T01 CryptoPort + phrase flow (local loopback) | ADR-021 constraints | E8-T01 | L | crypto package + tests | Seal/open round trips @50k events/s |
| E9-T02 Relay interfaces + loopback harness | ADR-042s shape | E9-T01, E2-T03 | L | sync package stubs | Two-harness reconciliation green |
| E9-T03 Conflict matrix proofs | ADR-043s semantics | E9-T02 | M | property suites | rename/rename, delete/edit, conclude/edit green |
| E9-T04 Licensing gate shape (stub token) | ADR-046 constraints | policy module | M | gates + token cache | Grace ≥30d fixture; capability-vs-access lint |
| E9-T05 Rules engine (prompt-permitted) | Scheduled park prompts only (no auto-close law) | E8-T08 | M | rules package | Chaos: rule never closes without intent path |
| E9-T06 Firefox adapters | Contract suite green FF | E3 all | XL | chrome adapters ff/ | Suite green; degradation matrix updated |
| E9-T07 FTS5/SQLite projection spike | 200k-tier search recommendation | E5-T01 | M | spike report + ADR note | Decision memo accepted by architect |

---

# SECTION 2 — MILESTONES (each = working product)

## M0 — "It boots" (Week 0–1) · Tier 0 start
- **Goal:** Loadable extension + CI constitution alive.
- **New capabilities:** installs; action icon; empty quiet page placeholder; all CI gates active (dep-law, egress, bundle, copy lint).
- **Demo scenario:** "Install → opens quiet page → deliberately violating PR is blocked by CI on screen."
- **Success criteria:** E1 tasks T01–T03, T13, T14 exit; permission manifest matches ADR-022 exactly.
- **Regression risks:** toolchain overfit to one Chrome version → beta lane exists from day one (E7-T06).

## M1 — "Truth Engine" (Week 1–3) · Tier 0 done + Tier 1 core
- **Goal:** Journal + projections + two-phase park working headlessly; chaos gate planned.
- **New capabilities:** ingest inventory; park/restore via console commands (no UI); intent ledger; boot reconcile; CRC integrity.
- **Demo scenario:** "In a live browser: park 80 tabs via dev console → kill SW mid-close (point #4 of points.txt) → relaunch → recovery report shows precise scope; zero tabs lost."
- **Success criteria:** E2-T01..T10 exit incl. property suites; park(100) ack ≤500ms measured on harness.
- **Regression risks:** compaction correctness (E2-T11) lands late in milestone → schedule XL task first in M1, not last.

## M2 — "You can touch it" (Week 3–4) · Tier 1 exit + Tier 2 start — **ALPHA begins (dogfood)**
- **Goal:** Real surfaces for the core loop.
- **New capabilities:** Guardian (park 4 ways, heartbeat per EES-R10), quiet page v1 (missions list, restore), first-run ingest (60-second relief), Start-mission, heuristic names.
- **Demo scenario:** "New profile with 47 junk tabs → install → 'Found 47 tabs → 6 missions' → user parks window → heartbeat '276 tabs safe' → force-crash via chrome://inducebrowsercrashforrealz → recovery card → everything back."
- **Success criteria:** Tier-1 chaos gate GREEN (release-blocking); a11y core zero-defect on shipped surfaces; dogfood by builders daily.
- **Regression risks:** surface scope creep (settings panes, themes) — rejected at gate: only MVP checklist merges.

## M3 — "Find anything" (Week 4–5)
- **Goal:** Retrieval layer complete.
- **New capabilities:** ⌘⇧K overlay (keyword BM25, scope widen), Recently Closed + sweeps, Trash + persisted Undo, dupe markers (passive).
- **Demo scenario:** "Search 'pricing purple table' finds parked tab; delete a mission by mistake → ⌘Z → back; close tabs without Ledge gestures → Recently Closed shows them."
- **Success criteria:** search p95 ≤100ms @10k on harness; undo round-trip property green; retention matrix fixtures pass.
- **Regression risks:** tokenizer edge cases sink time → golden corpus + CJK bigram fallback capped at M (escalate to XL only w/ TPM sign-off).

## M4 — "Come as you are" (Week 5–6) — **INTERNAL BETA entry**
- **Goal:** Portability complete; import refugees; export everything.
- **New capabilities:** 3 importers (preview→commit, batch-undoable), 3 exporters (streamed, verified), import UI.
- **Demo scenario:** "Hand it a OneTab export of 2,143 tabs → preview shows 6 dupes + 3 rejects → commit → missions clustered and named → export everything → open HTML file offline, no Ledge needed."
- **Success criteria:** round-trip corpus suite green; 100k-line stress within memory budget; export spec doc published in-repo.
- **Regression risks:** real-world export files are hostile (malformed) → hostile-fixture set required before exit (E7-T01 must predate this milestone!).

## M5 — "Bulletproof" (Week 6–7) — **PUBLIC BETA entry**
- **Goal:** Recovery UX + rescue console + polish + external testers.
- **New capabilities:** W7 real-restart flow (card gating), sessions cross-check, diagnostics + rescue console, health probes, copy/a11y polish pass, onboarding refinements from beta.
- **Demo scenario:** "Tester kills browser during heavy ingest → relaunch → precise card, one click, everything restored; rescue console shows all probes green."
- **Success criteria:** Tier-2 acceptance gate (EES Tier-2 exit criteria, all 8); beta cohort ≥100 installs with crash-free week; store-listing materials submitted (audit A2).
- **Regression risks:** recovery-card false positives annoy (silence law) → require loss-risk rule metrics from dogfood before widening.

## M6 — "v1.0 Stable" (Week 7–8) — **STABLE v1**
- **Goal:** Harden, sign, ship on CWS.
- **New capabilities:** none (feature freeze since M4 for v1 line; only fixes + governed improvements).
- **Demo scenario:** "Fresh profile → full EES §8.5 acceptance pass, live→reviewed→published."
- **Success criteria:** all release gates (EES §8 manifest list); public listing approved; rollback plan rehearsed (previous build re-submittable).
- **Regression risks:** CWS review latency/feedback (see Risk R-11) → buffer built into plan via early submission at M5.

## M7 — "It knows things" (Week 8–11) — **v1.1**
- **New capabilities:** AI pipeline live (queue/lanes/leases, isolation lint), on-device naming→summaries, resumption briefs, dupe actions, sprawl nudge, switcher + command palette, delta ring + checkpoints, conclude+outcome notes.
- **Demo:** "Park research window without touching anything → name and one-liner appear → Monday: 'Friday you were comparing CRMs — resume?'"
- **Success criteria:** Tier-3 exit criteria incl. **AI-off full-e2e green**; shadow-eval thresholds met; dupes FP ≤2%.

## M8 — "It remembers Mondays" (Week 11–14) — **v1.2**
- **New capabilities:** topics chips + correction, morning resume card, BuiltInAI adapter promotion (when capability present), 50k-corpus hardening; semantic embeddings provider behind flag (internal validation).
- **Success criteria:** budgets hold @50k; topics correction learning demonstrated; semantic spike decision memo lands (E9-T07 blocked by this, not vice versa).

## M9+ — v2 boundary proofs (post-v1.2, parallel track)
Crypto/relay loopback, conflict proofs, licensing-gate shape, rules engine, Firefox adapters, FTS5 spike — **no user-facing v2 features ship from this track without new ADR-era planning.**

---

# SECTION 3 — WORK PACKAGES (per milestone; independently reviewable)

*Package ID `M#-WP#`.* Contracts referenced by EES IDs (C#, Q-names, event names, port names).

### M0
| WP | Scope | Files | Outputs | Contracts | Tests |
|---|---|---|---|---|---|
| M0-WP1 | Toolchain+manifest+roots | manifest/, roots/, build cfg | loadable build | ADR-036/037, perms doc | build smoke |
| M0-WP2 | CI constitution | ops/ci | 4 gates live | dep-law rules, egress list | violating fixtures fail |
| M0-WP3 | Copy catalog skeleton | surfaces/components/copy | lint rules | Principle 22 lexicon | lint fixtures |

### M1
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M1-WP1 | Kernel trio | shared-kernel/{identity,clock,canon} | EES §2.1–2.3 | golden tables, property |
| M1-WP2 | Events+storage schema | shared-kernel/events, infrastructure/storage | EES §4/§5 | upcast fixtures, migrations |
| M1-WP3 | Journal full | infrastructure/journal | JournalPort, EES §5 events store | CRC seeds, soak, property |
| M1-WP4 | Two-phase + reconciler | intents, usecases/park-core, recovery | Intent events family, EES-R1/R2 | chaos points suite |
| M1-WP5 | Projection engine | infrastructure/projections | watermark/deltas protocol | determinism property |
| M1-WP6 | Ingest adapters | chrome/{tabs,windows,groups,sessions} | TabsPort…, ingest events | contract suite stable+beta |

### M2
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M2-WP1 | Domain MVP set | domain/lifecycle | decider matrix | invariant units 100% |
| M2-WP2 | Park/Resume use cases | application/usecases/{park,resume} | C3–C8, Snapshot/Park events | e2e golden W4/W5 |
| M2-WP3 | Guardian v1 | surfaces/guardian | C2–C7, HeartbeatUpdate stream (R10) | a11y core, component tests |
| M2-WP4 | Quiet page v1 | surfaces/quiet-page | GetBootstrap/GetLibrary/GetMissionDetail | render+virtualization perf |
| M2-WP5 | First-run + heuristics | usecases/firstRun, ai/providers/heuristic | C1, MissionFormed, confidence stamp | W1 acceptance script |

### M3
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M3-WP1 | Search engine | infrastructure/search | SearchRankPort, SearchQuery(Q) | recall goldens, lag-fallback |
| M3-WP2 | Overlay | surfaces/overlay | SearchQuery, commands registration | p95 perf, widen-copy |
| M3-WP3 | Recently Closed | stores + sweepers + views | retention settings keys | retention fixtures |
| M3-WP4 | Trash + Undo | usecases/{delete,undo,trash} | C9? no—C15–C18, EntityTrashed atom | R9/R13/R14 fixtures |

### M4
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M4-WP1 | Exporters | infrastructure/exporters | ExportRendererPort, C22, ExportReady | round-trip, corruption paths |
| M4-WP2 | Export spec doc | docs/export-format-v1.md | covenant v1 | example files validate |
| M4-WP3 | Importers | infrastructure/importers | ImporterPort, C20/C21, ImportCommitted (R11) | golden + hostile fixtures |
| M4-WP4 | Import UI | quiet-page import panel | ImportProgress/Ready streams | corrupt-abort e2e |

### M5
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M5-WP1 | W7 recovery flow | recovery card + gating | RecoveryAvailable, bootReport | real-restart e2e |
| M5-WP2 | Cross-check panel | recovery + nativesessions | RestoreAccepted variant | gap-degrade fixture |
| M5-WP3 | Diagnostics + rescue | infrastructure/diagnostics, quiet-page rescue | C23/C24/C26, probes | probes self-test, decay |
| M5-WP4 | Polish passes | surfaces/* copy/a11y | copy lint, a11y checklist | zero-defect sign-offs |

### M6
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M6-WP1 | Freeze+fix | all | version tags | full gate rerun |
| M6-WP2 | Store packet | listing assets, privacy policy URL (audit A2), screenshots | CWS requirements | manual review sim |
| M6-WP3 | Rollback rehearsal | ci release tooling | previous-build resubmit path | rehearsal check |

### M7 (v1.1)
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M7-WP1 | AI infra | infrastructure/ai | JobOffer/Claimed/Heartbeat/Result, isolation lint | chaos exact-once |
| M7-WP2 | On-device naming/summaries | providers/ondevice | AIProviderPort, confidence constants (R7) | shadow-eval harness |
| M7-WP3 | Briefs + nudge + dupes v2 | guardian additions | NudgeOffered (R15), dupe actions | dismissal memory fixtures |
| M7-WP4 | Switcher + palette | overlay additions | C28 atomics | chaos atomicity |
| M7-WP5 | Delta ring + checkpoints | projections additions | delta_ring store contract | gap-rate measurement |

### M8 (v1.2)
| WP | Scope | Files | Contracts | Tests |
|---|---|---|---|---|
| M8-WP1 | Topics chips | topics projections + UI | MemoryArtifact(topics), R12 joins | correction learning fixture |
| M8-WP2 | Morning card | guardian card | session-start detection (R15 clocks) | silent-absence law |
| M8-WP3 | BuiltIn adapter | providers/builtin | capability probe contract | degrade e2e |
| M8-WP4 | 50k hardening + embedder flag | perf deltas, providers/embedder(flag-off) | SearchRankPort compose | budgets @50k |

---

# SECTION 4 — DEPENDENCY GRAPH

```mermaid
flowchart LR
    M0(M0 Boot) --> M1(M1 Truth Engine)
    M1 -->|CHAOS GATE G1| M2(M2 Alpha)
    M2 --> M3(M3 Retrieval)
    M2 --> M3b((parallel))
    M3b --- FX[Fixture corpus E7-T01]
    FX --> M4
    M3 --> M4(M4 Internal Beta)
    M4 --> M5(M5 Public Beta)
    M5 -->|ACCEPTANCE GATE G2| M6(M6 v1 Stable)
    M6 --> M7(M7 v1.1 AI)
    M6 --> BR((parallel))
    BR --- SOAK[Beta-channel soak]\nSTORE[CWS review buffer]
    M7 --> M8(M8 v1.2)
    M8 --> M9(M9+ v2 boundaries)
    E8T02[Isolation lint E8-T02] -.must precede.-> E8T03[OnDeviceML E8-T03]
    E5T03[Exporters] -.round-trip feeds.-> E5T05[Importers]
    E2T11[Compaction E2-T11] -.hard dependency.-> PURGE[Trash purge flows E4-T09]
```

**Critical path (long pole):** E1 toolchain → journal (E2-T01) → two-phase (E2-T02) → reconciler (E2-T06) → park/resume (E4-T03/04) → W7 flow (E6-T01) → v1 gates. **Any slip on E2-T02/E2-T11 moves every date right. Protect them with earliest scheduling + pairing.**
**Parallelizable:** fixture corpus; perf harness; a11y program; docs set; diagnostics core; store assets; beta-lane soak — all non-blocking shadows of the path.
**Merge points:** G1 chaos gate (nothing user-facing merges without it); G2 acceptance gate (nine workflows); M4 import/export code-freeze for v1; M7 feature-flag merge strategy for AI (flag-off until shadow-eval pass).
**High-risk integrations:** (1) two-phase × SW mortality; (2) compaction × purge law (XL task); (3) workroom × WASM CSP; (4) importers × hostile real files; (5) quiet-page × 1k-mission rendering budget; (6) overlay × CJK tokenizer.

---

# SECTION 5 — QUALITY GATES

| Gate | Required tests | Performance | Security | Accessibility | Docs | Release criteria |
|---|---|---|---|---|---|---|
| **M0 exit** | build smoke, CI red-fixture set | bundle budgets live | perm-diff review, egress ∅ | n/a | permissions.md | TPM sign-off |
| **M1 exit (G1)** | chaos 0-loss, property (replay, purge-law), contract suite | park ack ≤500ms; wake ≤200ms | validators fuzz green | n/a | journal/segment spec, runbook v0 | **nothing user-facing without G1** |
| **M2 exit** | W1/W4/W5/W7 golden e2e, units 100% invariants | quiet FCR ≤300ms @1k | CSP audit | a11y core zero-defect | onboarding doc | dogfood 1 wk, crash-free |
| **M3 exit** | W6/W13/W14/W15 + undo props | search p95 ≤100ms @10k | scheme-smuggle suite | keyboard nav full | tokenizer notes | regression seeds current |
| **M4 exit (Internal Beta)** | round-trip corpus, R11 batch law, hostile files | import mem ≤ budget; export ≤60s/100k | file-guard caps proven | preview panel audit | export-format-v1 published | 20–50 seeded users green week |
| **M5 exit (Public Beta)** | Tier-2 acceptance list (8 items), real-restart e2e | all §7.1 budgets | security gates full pass incl. dep audit | §7.4 zero-defect | runbooks, threat model, degradation matrix | CWS listing submitted; crash-free 100-user week |
| **M6 exit (Stable v1)** | full suite rerun on frozen bits; rollback rehearsal | budgets on release bits | release manifest signed | re-audit | changelog, store copy | publish + rollback plan |
| **M7 exit (v1.1)** | AI-off e2e, exact-once chaos, dupe FP ≤2%, shadow evals | interactive-lane AI budgets | isolation lint fixture red/green | briefs/nudge a11y | provider matrix doc | flag-on rollout 10%→100% (bundled flags only, ADR-023) |
| **M8 exit (v1.2)** | topics corrections, morning-card law, 50k suite | budgets @50k | wasm CSP re-audit | chips keyboard ops | embedder decision memo | stable channel full |

---

# SECTION 6 — RISK REGISTER

| ID | Risk | Likelihood | Impact | Mitigation | Fallback | Detection |
|---|---|---|---|---|---|---|
| R-01 | Two-phase mutation defect under kill | Medium | Catastrophic (trust) | Chaos suite M1; enumerate kill-points; property proofs | Ship-block at G1 (law) | Chaos CI; field = zero by design |
| R-02 | Compaction purge-exclusion bug ⇒ deleted data persists | Low-Med | Charter violation | Property test "bytes absent"; epoch design (Blue §14.3) | Disable compaction (journal grows, alert tune) | property suite + spot integrity scans |
| R-03 | Offscreen reason-enum/policy drift | Medium | AI/import-offscreen breakage | Capability resolution layer; beta-lane soak | Degrade AI to heuristic; move parse to page context temp | beta CI red; spawn telemetry probe |
| R-04 | WASM CSP shifts (wasm-unsafe-eval) | Low-Med | on-device ML blocked | CSP audit per channel; document exception | Heuristic tier (always present per ADR-018) | beta soak + release notes watch |
| R-05 | IDB quota/eviction on constrained profiles | Low | Data risk | unlimitedStorage + persist() request + quota probe | Alert+export nudge (calm, rescue console) | health probe threshold 80% |
| R-06 | Solo/small-team bandwidth vs schedule | Medium-High | Slips | Scope police (M6 freeze; Tier-4 = proofs only); critical path pairing | Descope M7 items to M8 (pre-approved ladder) | weekly burndown vs gates (not dates) |
| R-07 | Hostile import files in wild | High | Beta churn | Hostile fixture set pre-M4; quarantine semantics | Parser hotfix lane (data-format = fast ship) | rejects-rate probe in diagnostics |
| R-08 | Chrome Web Store review latency/feedback | High | Launch date slip | Submit at M5 (buffer); exact perms already minimal; privacy policy ready early | Staged: unlisted→public listing; feature explainer video in listing | review console status |
| R-09 | Tokenizer quality complaints (CJK/RTL) | Medium | Search trust dents | Golden recall corpora; bigram fallback | Language-targeted follow-up release | beta feedback triage |
| R-10 | Perf regression unnoticed between harness runs | Medium | Trust (Principle 23) | nightly perf compare vs baseline | block release on >10% any-metric delta | nightly harness report |
| R-11 | Beta-channel Chrome breaking change lands between soaks | Medium | Sudden breakage | Beta lane red⇒owner ≤48h rule; contract encapsulation | hotfix release w/ adapter patch | beta CI |
| R-12 | Keyboard shortcut conflicts (locales/other extensions) | Medium | UX friction | Conflict-audit at install + remap UX (Spec law) | alternative default map shipped | install-time audit logs (local) |
| R-13 | Metrics-blindness (no telemetry) masks quality issues | Known/accepted | Slow learning | opt-in beta channel + support-triage themes + probes on-device | charter review only (ADR-027/28 law) | weekly support digest |
| R-14 | Fixture corpus legal/privacy contamination | Low-Med | Legal | synthetic-first policy; sanitize real exports; provenance log | regenerate corpora | fixture review sign-off |
| R-15 | Scope creep: morning-card/pull-in to v1, themes/settings bloat | High | Schedule blowout | Gates enforce MVP list; creep-log with TPM veto | defer to v1.1/1.2 (documented parking) | weekly scope review vs EES §8.2 |

---

# SECTION 7 — CODE REVIEW CHECKLIST

**Architecture** □ imports obey dep-law (no domain→infra; no surface→storage/chrome/ai) · □ new chrome.* call wrapped in port adapter only · □ new event type registered (append-only) with upcast note · □ contract changes bump `v`/contractHash + dual-read plan · □ new permission? → ADR required, auto-reject otherwise
**Correctness** □ mutation flows via hub single-writer · □ durability hinge: intent+snapshot same txn before browser change · □ idempotency keys on retries; terminal-state exactly-once · □ confidence-tier logic only in Memory layer (R18) · □ race tolerances (R2/R3/R14) respected · □ no wallClock-dependence for correctness (R8)
**Performance** □ budgets referenced and tests updated if path touched · □ no journal reads on query path · □ batching laws (20/50ms) for ingest; deltas ≤500/frame · □ offscreen work lane-classified · □ bundle delta ≤ budget
**Security** □ untrusted strings only via safe-text helpers (no innerHTML) · □ URL scheme allowlist re-check at every open/restore · □ message payload validated at boundary; sender-context allowlist · □ no new egress endpoint (guard auto-check) · □ CSP unchanged or ADR-noted
**Accessibility** □ keyboard path exists & tested · □ live-region semantics polite · □ 44px targets · □ reduce-motion honored · □ strings from catalog (lint)
**Maintainability** □ ≤5 runtime deps policy; new dep has removal plan · □ dead-code/flag-expiry rule (N+2) · □ docs touched by change updated (docs gate) · □ calm-copy rule for any user-facing text
**Testing** □ every new behavior ships with its test (test-first for bug fixes — seed corpus) · □ property coverage extended for new invariants · □ chaos points enumerated if mutation path added · □ fixtures anonymized/licensed (R-14)

---

# SECTION 8 — RELEASE PLAN

## Alpha (internal, from M2)
- **Objectives:** daily-driver proof of the loop; find emotional/paper-cut issues telemetry can't.
- **Feature set:** ingest, first-run, park/resume, heartbeat, missions list, crash recovery (backend).
- **Exit criteria:** 2 consecutive dogfood weeks crash-free; zero data-loss incidents; top-20 paper-cuts fixed.

## Internal Beta (from M4; group-invite 20–50)
- **Objectives:** portability proof on real foreign data; hostile-file field study.
- **Feature set:** + importers/exporters, search overlay, trash/undo, recently closed.
- **Exit criteria:** ≥90% import sessions commit successfully; rejects-report rate trending down week-over-week; exports open cleanly offline (spot-verified).

## Public Beta (from M5; 100–500 via unlisted/limited listing)
- **Objectives:** trust proof at modest scale; recovery-flow calibration; store-listing rehearsal.
- **Feature set:** + W7 card flow, rescue console, probes, polish pass.
- **Exit criteria:** crash-free 100-user week; zero W7 false-positive complaints pattern; support load ≤ manageable threshold; store review passed (unlisted→listed switch rehearsed).

## Stable v1 (M6)
- **Objectives:** public availability matching EES Tier-2 scope exactly — the nine workflows, flawless.
- **Exit criteria:** release-gate manifest complete (EES §8 list); rollback rehearsed; listing live.

## v1.1 (M7)
- **Objectives:** intelligence without trust dilution; measure AI keeps/disables ratio via dogfood cohorts (charter-safe: local probes only).
- **Feature set:** AI pipeline infra, on-device naming/summaries, briefs, dupe actions, nudge, switcher+palette, conclude+notes, delta ring/checkpoints.
- **Exit criteria:** Tier-3 gates incl. AI-off-e2e; flag ramp 10→100%; dupe FP ≤2%; zero AI-caused mutation (structural, but asserted by audit).

## v1.2 (M8)
- **Objectives:** semantic-era readiness at 50k scale.
- **Feature set:** topics chips, morning card, BuiltIn adapter, hardening; embedder behind flag.
- **Exit criteria:** budgets @50k; correction-learning evidence; embedder go/no-go memo approved → unflag in v1.3 or hold.

## v2 line (post-M8, separate planning era)
Sync (E2E), semantic depth, rules, share links, licensing — initiated by new ADR-era roadmap; Tier-4 proofs are prerequisites, never shipped silently.

---

# SECTION 9 — IMPLEMENTATION AUDIT

**Findings & resolutions (all compatible with locked docs):**

**A1 — Timeline tension resolved.** Early business docs mused a "2–3 week MVP." This roadmap's engineering MVP is **6–8 weeks** (M0→M6). Resolution: the 2–3-week figure survives only as the *prototype-without-durability* — and shipping that would violate ADR-003/011. **Binding: marketing may promise "weeks," never a date, until G1 passes.**

**A2 — Hidden work: store & legal packet.** Missing from exec-spec build list: CWS requires a published privacy policy URL, listing copy/screenshots, support contact, and (for this permission set) a compelling justification narrative. **Resolution:** added to M6-WP2; owner slot D; start at M3 (privacy policy mirrors ADR-020/021/022 — mostly a translation task).

**A3 — Hidden dependency: fixture corpus must predate M4.** Real-file importers cannot converge without real OneTab/SessionBuddy/bookmark corpora (incl. hostile variants). **Resolution:** E7-T01 explicitly scheduled M2–M3, blocking-relationship added in §4 graph; synthetic generators deterministic (seeded) for perf harness reuse.

**A4 — Schedule risk: calendar-time soaks.** Beta-lane soak and CWS review consume *calendar*, not effort. **Resolution:** both run in parallel shadows from M0 and M5 respectively; no task may "wait for soak" as its critical input.

**A5 — Scope creep pressure points.** Highest gravity: settings bloat, themes, timeline view, "just one more AI toggle." **Resolution:** creep-log owned by TPM; Principle 27 (delete-before-add) invoked at weekly review; v1 freeze begins M4 (portability is last v1 feature epic).

**A6 — Missing-but-required: uninstall/exit offer mechanics.** Spec §1.4 mandates export offer on uninstall. **Resolution:** implemented via lifecycle-page hook (local page, no network) as E4-T16 task added ≤M3 scope (S complexity; uses existing exporter).

**A7 — Test-data provenance risk.** **Resolution:** R-14 in register; fixture sign-off is a docs-gate item at M3/M4.

**A8 — Support burden without telemetry.** **Resolution:** weekly support digest ritual + top-5 issue→seed-corpus rule (E7-T04); beta channel opt-in diagnostics offer is the only sanctioned quantitative loop (charter-compatible, off by default).

**A9 — Compaction XL task clustering.** E2-T11 (XL) and E5-T01 (XL) collided in original draft schedule (same engineer-slot). **Resolution:** compaction pulled into M1 (starts week 2); search pushed to M3 start; slot P2 handles search while P1 finishes compaction — documented pairing.

**A10 — Rollback plan.** **Resolution:** M6-WP3 keeps the previous approved build submittable; store rollback ≠ code rollback — deployment doc clarifies both.

**Final review statement:** with A1–A10 applied, every epic traces to EES contracts, every milestone yields a runnable product, every gate cites measurable criteria, the critical path is isolated, and eight of the fourteen register risks have in-plan fallbacks rehearsed *before* their trigger conditions. The team can execute from first commit to stable v1 using this document alone.

---

*Roadmap ends. Operational next step: populate the task board from Section 1 IDs (each task = one board card with its gate links), and schedule the M1 critical-path pairing session for E2-T01/T02/T11.*
