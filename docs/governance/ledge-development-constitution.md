# LEDGE — DEVELOPMENT CONSTITUTION
**Phase 7 · Permanent Engineering Law · Ratification v1.0**
*Governing order (supremacy clause):* **Product Vision & Specification** (what users were promised) → **ADR** (architecture law) → **this Constitution** (engineering law) → style guides & team habits. On conflict, the higher document wins; the lower must be amended, never silently violated. This Constitution may not override the ADR; it exists to make obeying the ADR effortless and violating it visible.

**Amendment law:** changes require (1) a written proposal citing evidence, (2) approval of the Architect + TPM, (3) append-only entry in the amendment log. Target: **≤2 amendment rounds per year.** If a rule needs frequent exceptions, the rule is wrong — fix the rule, or delete it; do not train contributors to ignore law.

**Enforcement notation:** `[CI]` automated gate · `[REVIEW]` human review duty · `[RITUAL]` scheduled practice · [GATE]` milestone/release gate. A rule without an enforcement mechanism is a wish; this document tries to contain no wishes.

---

# SECTION 1 — CORE PRINCIPLES

## P-01 · Correctness over speed
**Why:** Ledge's entire market position is "we never lose your thoughts." One durable-correctness scandal outweighs a year of velocity (Vision §1, ADR-003).
**Do:** prove invariants with property tests; block merges on failing gates; take the extra day to make park atomic. **Anti-patterns:** "ship fast, test later"; merging with a red chaos lane "just this once"; swallowing errors to keep the UI smooth.
**Exceptions:** none for truth paths. For cosmetic/UI polish, speed may win if failure cannot corrupt data and degrades gracefully (ADR-026 fail-open law).

## P-02 · Durability is non-negotiable
**Why:** the snapshot-before-close invariant is the product's oath (Spec W4; ADR-011). A durability shortcut is not technical debt — it is fraud against the user.
**Do:** intent-before-mutation in one transaction; conservative recovery (leave-open and disclose, never guess); physical purges honor the purge law absolutely. **Anti-patterns:** optimistic acknowledge; "temporary" non-durable fast paths; cleanup jobs that guess completion.
**Exceptions:** none. This is the constitution's *only* absolute law. (EES-R1/R9 codify it in contracts.)

## P-03 · Privacy by architecture, not policy
**Why:** promises rot; structures don't. Honey and Great-Suspender happen to products that had privacy *statements* but not privacy *engineering* (Vision F2, ADR-020).
**Do:** empty egress table; redacted logs by default; derived data dies with source; denylist-deny financial/medical indexing. **Anti-patterns:** "just this one anonymous analytics ping"; collecting data "because we might need it"; redaction as an afterthought feature.
**Exceptions:** explicitly consented, capability-gated, charter-reviewed paths only (sync v2, Ledge+ cloud depth) — each an ADR event.

## P-04 · Performance is a trust feature
**Why:** Principle 23 — a laggy "safe" indicator reads as a lie. Slowness teaches users not to believe us.
**Do:** budgets as law (§7); measure before optimizing; keep the interactive lane sacred. **Anti-patterns:** "it's fast on my machine"; unmeasured pessimizations "for readability"; caching to mask slow queries instead of fixing them.
**Exceptions:** none for regression (budgets tighten-only, ADR-029). New features may request new budgets — by ADR note with evidence.

## P-05 · Architecture before convenience
**Why:** every shortcut around a port/layer creates an invisible coupling that compounds for years. The ADR already paid for the boundaries — respect the purchase.
**Do:** new platform capability → new port method; new behavior → new use case; cross-cutting access → messages, never digging. **Anti-patterns:** importing an adapter directly "to save time"; reading storage from a surface; reaching into the AI queue from UI.
**Exceptions:** prototypes/spikes outside `main` (§10, timeboxed, never merged).

## P-06 · Delete before adding
**Why:** Principle 27 — features must re-earn existence. Code is liability; every file is rented, not owned. Merlin/Sider-style scope cancer is what we refuse to become.
**Do:** creep-log with TPM veto (Roadmap §9-A5); dead code deleted on sight; flag expiry lint. **Anti-patterns:** "keep it, we might need it"; commented-out code; v2 scaffolding shipped into v1 binaries.
**Exceptions:** dual-read compatibility windows (message contracts, N-2 sync) may duplicate *temporarily* — with an `EXPIRY` marker and removal date.

## P-07 · No hidden behavior
**Why:** a senior engineer in year 3 must be able to predict system behavior from reading it. Magic is tax on every future contributor.
**Do:** explicit wiring at composition roots; visible state transitions; decisions recorded in code via named constants/policies. **Anti-patterns:** reflection-y dispatch; implicit global toggles; side effects in getters; "convenient" auto-anything the user didn't invoke (Spec §6.12 law).
**Exceptions:** framework-internal magic we do own is banned; platform (browser) behavior we don't own must be wrapped and documented in the adapter.

## P-08 · Small modules, explicit ownership
**Why:** ownership is how 100 contributors don't break each other; smallness is how one mind holds a module.
**Do:** one purpose per module; OWNERS/CODEOWNERS current; new module = named owner + README ≤1 page. **Anti-patterns:** `utils/` dumping grounds; orphaned files; modules with three purposes and no champion.
**Exceptions:** registry/table files (event catalog, error catalog, copy catalog) may grow large *as data* — single-purpose tables, not logic.

## P-09 · Degradation is designed, not accidental
**Why:** Principle 29 — AI off, sync off, cloud gone: still coherent. The degradation matrix is a tested artifact, not a hope (EES §7.6).
**Do:** fail-closed on truth, fail-open on cosmetics (ADR-026); every lane has a shedding order; heuristic tier always exists. **Anti-patterns:** features that simply stop working when a provider dies; error states that trap the user; silent half-failures.
**Exceptions:** none recorded; new capabilities must declare their degradation path in their PR.

## P-10 · Boring technology
**Why:** the innovation tokens are spent on durability and trust (the two hardest, rarest things in this category). Everything else is settled science.
**Do:** ≤5 runtime deps; vanilla surfaces; standard TS; tools replaceable yearly (ADR-036/044h). **Anti-patterns:** framework-of-the-month; adopting tech to learn it; Resume-Driven Development.
**Exceptions:** on-device ML runtimes — the one domain where the cutting edge is the product (isolated behind providers, ADR-018).

## P-11 · Every PR leaves the campground cleaner
**Why:** entropy is the default; hygiene must be the default too, or the codebase converges to mud in N×100 PRs.
**Do:** tiny opportunistic fixes in the files you touch (kept in separate commit within PR); remove a dead branch while you're there. **Anti-patterns:** giant "cleanup while refactoring everything" PRs (forbidden — refactors are standalone, §10); littering TODOs.
**Exceptions:** none, but scope discipline applies: clean what you touched, not what you merely walked past.

*(Ten principles, one absolute law. If you memorize one line: **durability is non-negotiable.**)*

---

# SECTION 2 — CODE STANDARDS

| Area | Standard | Enforcement |
|---|---|---|
| **Naming** | Commands `VerbNoun` · Events `PastTense@1` · Stores `snake_case` · Ports `*Port` · Adapters `*Adapter` · Errors `E_CATEGORY_REASON` · Copy keys `msg.area.name` · Constants `SCREAMING` in per-domain catalogs. No abbreviated stdlib-cute names (`tmp`, `hndlr`); rename mercy allowed at boundaries only | [CI] naming lint |
| **Folder structure** | `src/` tree exactly per Blueprint §3 (domain/application/infrastructure/surfaces/shared-kernel/roots). New top-level folder = ADR note. No `misc/`, no `common2/` | [CI] structure lint |
| **File size** | Target ≤300 lines; warning at 400; hard gate 800 (exempt: generated files, registry/table files per P-08). A file over budget needs a split plan, not an apology | [CI] warn/block |
| **Function size** | Target ≤40 lines; hard limit 60 for domain logic; use-case functions may reach 80 if they are *sequence-only* (no branching depth >3) | [REVIEW]+[CI] complexity lint (branch depth) |
| **Class size** | Classes are rare (DDD-lite entities only); if used, ≤150 lines and invariant-protecting; otherwise plain functions/values. No inheritance hierarchies beyond one level | [REVIEW] |
| **Comments** | Explain **why**, never what (the code says what). ADR references encouraged (`// ADR-011: intent precedes mutation`). No commented-out code `[CI: block]`. No TODO without `DEBT-id` (§10) | [CI]+[REVIEW] |
| **Documentation (in-code)** | Public contract behavior documented at the contract (registry entries), not scattered in implementations. Module README ≤1 page (P-08) | [REVIEW]+docs gate |
| **Formatting** | One formatter config, CI-enforced; formatting PRs are separate and machine-generated only; no format debates ever | [CI] auto |
| **Logging** | Only via DiagnosticsPort: leveled, structured, redacted-by-default (URLs hashed). `console.*` banned in committed code except inside `diagnostics/` itself. Log data classes obey ADR-020 taxonomy | [CI] lint + audit |
| **Error messages** | User-visible errors come from the copy catalog via `messageKey`/`recoveryKey`; never `.message` passthrough; calm-copy lexicon lint. Internal errors typed per ADR-026 taxonomy; expected failures return `Result`, unexpected throw | [CI] no-unmapped-error lint |
| **Magic numbers** | Banned outside tests; constants live in domain catalogs (e.g., confidence tiers R7: HIGH≥0.85, MED 0.60–0.85; budgets §7.1) — changing a budget constant is a docs-visible event. Exempt in tests: 0, 1, -1, obvious literals | [CI] lint |
| **Configuration** | Three sanctioned channels only: build constants, bundled release flags (ADR-023), settings store (versioned keys). **Forbidden:** remote config, env-var scraping scattered in code, config files not in registry | [CI]+[REVIEW] |
| **Constants** | Each bounded context owns one constants module; paths import upward-forbidden; registry constants carry units in names (`PARK_ACK_BUDGET_MS`) | [CI] lint |

---

# SECTION 3 — ARCHITECTURAL RULES (immutable laws)

Violations of A-01…A-16 are merge-blockers `[CI]` wherever mechanically detectable, else `[GATE]` at release audit. No exceptions without ADR supersession.

- **A-01** Domain imports nothing outside `shared-kernel`. *(Blue §4)*
- **A-02** `chrome.*` appears only in `infrastructure/chrome/` adapters and `roots/`. *(ADR-009)*
- **A-03** Storage engine (Dexie) imported only inside `infrastructure/storage/`. *(ADR-013)*
- **A-04** The `ai/` package may not import any mutation-capable port, journal access, surfaces, or chrome adapters — enforced by symbol denylist. *(ADR-041)*
- **A-05** Surfaces are authority-free: messages only; **no optimistic truth mutations** — pending→Applied honesty (EES-R1). No storage access, no browser calls.
- **A-06** No circular dependencies — none, including test-only cycles.
- **A-07** No shared mutable state across contexts; state moves as versioned messages only (ADR-010).
- **A-08** Single-writer law: all mutations flow through the hub's command dispatcher (ADR-005).
- **A-09** Stored events are immutable; event types are append-only; payloads change only via new `@version` types + upcasters (ADR-033).
- **A-10** Egress allowlist: **∅** in v1; any addition = ADR + redaction-gateway wiring + guard update. Remote code/config is contractually indistinguishable from malware here (charter).
- **A-11** Permission set changes = ADR + manifest diff sign-off (semi-irreversible trust decision, ADR-022).
- **A-12** User-visible strings only via copy catalog; calm-copy lexicon lint; no exclamation marks (Principle 22).
- **A-13** Export-format covenant: readers accept every published major forever (ADR-045). Breaking this is a constitutional crime equivalent to data loss.
- **A-14** Unknown-field preservation: readers tolerate and round-trip unknown fields (forward tolerance for sync skew and rollbacks, ADR-014/033).
- **A-15** Content scripts (future) require per-site consent, Zone-1 reduced message schema, and an ADR — default off forever until then (EES §3.1).
- **A-16** No telemetry endpoints, analytics SDKs, or "anonymous pings." Quantitative learning flows only through the charter-gated paths (ADR-027/028). Violation = instant revert + incident review.

---

# SECTION 4 — TESTING PHILOSOPHY

**T-01 Test-first, and bug-first:** every field bug becomes a failing test *before* the fix, grafted into the regression seed corpus (EES §8, Roadmap E7-T04). `[GATE]`
**T-02 What we prove, not how much we cover.** Coverage floors: domain invariants 100%, domain layer ≥90% line+branch, every port method contract-tested, every message kind has validation fixtures. Global percentage targets are deliberately absent — they are gamed, and we refuse to train that. `[CI]`
**T-03 Property tests own invariants:** replay determinism (same journal ⇒ same models), purge-law byte-absence, canonicalization idempotence, import batch laws, and (Tier 4) sync merge commutativity. Seeds: ≥1k per PR lane, 10k nightly. `[CI]`
**T-04 Chaos is contract-verification, not theater:** kill-points enumerated in `ops/chaos/points.txt`; **any PR adding a mutation path must enumerate its kill points** — the list is part of the PR. Exit standard: zero data loss, correct conservative branch (EES Tier-1 gate, permanent). `[GATE]`
**T-05 Performance tests are regression tests:** nightly baseline compare; any metric >10% worse blocks release. Budgets tighten-only (ADR-029). `[CI]`
**T-06 Contract tests are the portability proof:** identical suite green on every adapter family before that family may ship (ADR-032). `[GATE]`
**T-07 Accessibility testing is zero-defect:** new surfaces don't merge with known a11y defects; checklist + automated + a manual pass at each milestone gate (EES §7.4). `[GATE]`
**T-08 Flakiness has an SLA:** quarantine within 48h, fix-or-delete within 14 days; quarantined list is public in-repo; skipped tests carry `EXPIRY` markers and fail the build past expiry. `[CI]`
**T-09 Definition of sufficient testing (per subsystem):** (a) its contracts have fixtures, (b) its failure modes from the Blueprint §9 table each have a test, (c) its invariants have properties, (d) its budgets have harness rows. When (a)–(d) hold, stop testing it and go build product.
**T-10 Test data ethics:** synthetic-first; any real-file fixture is sanitized, attribution-logged, and privacy-reviewed (Roadmap R-14). `[GATE]`

---

# SECTION 5 — CODE REVIEW STANDARD

**Reviewer duty (all ten axes, every PR — small PRs make this cheap; that's the point):**

1. **Correctness** — do invariants hold by construction? are R1–R20 resolutions honored where applicable? is terminal-state exactly-once preserved?
2. **Architecture** — dep-law respected? no port bypass? no layer leakage? new capabilities reach through contracts only?
3. **Performance** — budget touchpoints identified; perf-sensitive diffs carry before/after harness numbers (not vibes); batching/lane laws respected.
4. **Security** — untrusted input flows through validators; allowlists honored; no new egress, permission, or CSP change without ADR.
5. **Accessibility** — keyboard path, live regions, targets, motion, zoom; checklist linked.
6. **Privacy** — data-class taxonomy respected; derived data purge-chained; redaction default preserved; consent boundaries untouched.
7. **Maintainability** — names explain; comments say *why*; duplication challenged; campground cleaner than found (P-11).
8. **Documentation** — docs-gate items identified and updated (§9 triggers); registry entries for new contracts/events/errors.
9. **Testing** — T-number compliance; chaos points enumerated for mutation paths; failure modes covered, not just happy paths.
10. **Risk** — blast radius named in the PR (what breaks if this is wrong); rollout/flag state explicit; rollback trivially possible.

**Mechanics:** PR ≤400 changed lines target, hard ceiling 1,000 for features (migrations/generated exempt, isolated commits); PR template sections: *Contracts touched · Events · Budgets impacted · Kill points added · Docs updated · Risk* — template linted `[CI]`. Review SLA 48h when team ≥2 `[RITUAL]`. **Truth modules** (`journal/`, intents, compaction, `recovery/`, storage migrations) require **2 reviewers or a senior owner counter-signature** when team ≥2; in solo configuration, the mandated substitute is the chaos suite + tier-gate rerun + 24-hour self-re-review delay `[GATE]`. No self-merge on truth modules, ever. Emergency path: §11 hotfix law.

---

# SECTION 6 — DEPENDENCY POLICY

- **D-01 Ceiling: ≤5 runtime dependencies** (ADR-044h; current: Dexie). Dev-dependencies unconstrained in count but audited. `[CI] dep-count lint`
- **D-02 Admission checklist (all required, in PR):** (1) necessity vs write-ourselves estimate; (2) unpacked size vs bundle budget; (3) maintenance health (commits, issues, bus factor); (4) security record & audit; (5) license compatibility; (6) **removal plan** — which adapter quarantines it, what replaces it; (7) zero network behavior (privacy audit item). A dependency without a removal plan does not exist as far as we are concerned.
- **D-03 Quarantine law:** any runtime dependency may be imported only inside its designated adapter/module (Dexie → storage; future libsodium → crypto). No dependency type may escape its quarantine into domain/application code. `[CI]`
- **D-04 Pinning:** exact versions; lockfile committed; updates are deliberate PRs (never automated blind bumps for runtime deps); known-vuln versions block CI via audit. `[CI]`
- **D-05 Removal:** annual dependency renewal review `[RITUAL]` — for each dep: still needed? still quarantined? still ≤ its risk budget? Removal PRs are celebrated, scoped standalone.
- **D-06 AI models ≠ dependencies** in the count, but are vendored artifacts with their own hygiene: pinned hashes, license papers, lazy load (bundle law §7.3), kill-switch via provider ladder.

---

# SECTION 7 — PERFORMANCE CULTURE

Permanent rules; budgets per EES §7.1–7.3 are contract, not aspiration.

- **Measure-first law:** no optimization without measurement; no pessimization claim without harness evidence. Perf-affecting PRs attach numbers. `[REVIEW]`
- **Memory:** SW ≤30MB steady · offscreen ≤40MB idle (models unload ≤60s idle) · surfaces ≤60MB active · standing total <75MB · 24h soak leak delta <5MB. `[CI gate]`
- **CPU:** SW work slices <5s; background bursts ≤30s and idle/battery-gated (IdlePort); ingest amortized ≤5ms/event.
- **Bundle:** budgets per entry (core SW ≤300KB gzip; quiet-page ≤150KB; overlay+guardian ≤80KB). New import that adds >20KB gzip carries justification in PR. Dynamic import of **bundled chunks only** (R19). `[CI]`
- **Rendering:** lists >100 rows virtualized; delta application ≤500 ops/frame; passive listeners; no layout-thrash loops (measured on quiet page).
- **Startup:** SW wake rehydrates the minimal set (meta+watermarks) — no AI, no index warmup on wake path (budget ≤200ms).
- **Search:** index-first; freshness tail-scan capped (≤2k events, EES §10 §5); correctness over freshness law stands above speed.
- **Background work:** lanes with shedding order (background → maintenance → interactive never shed); alarms batching (wake budget ≤6/hr steady).
- **Caching:** all caches disposable; correctness cache-independent (cold-cache E2E mode, ADR-030); every cache has TTL or watermark invalidation and a size cap — an unbounded cache is a defect, not an optimization.
- **Budget governance:** new budgets via ADR note + harness row; regressions are blockers; improvements are celebrated and locked in as the new floor.

---

# SECTION 8 — SECURITY CULTURE

- **S-01 Permissions minimalism:** ADR-022 set is sacred; additions need ADR + one-sentence frightened-user justification (Principle 24) + manifest diff sign-off. Optional permissions only post-consent-sheet. `[GATE]`
- **S-02 Validation at every boundary (catalog EES §11):** URL scheme allowlist re-checked at *every* open/restore; safe-text-only rendering (zero `innerHTML` on external strings — lint denylist); size caps + timeout guards on all parsed files; message payloads validated per sender context allowlist. `[CI]+fuzz`
- **S-03 Storage security:** purge law physical (compaction exclusion property-tested); no secrets in plain IDB; phrase-derived keys (v2) never persisted raw; diagnostics redaction default with auto-decay. `[CI]+property`
- **S-04 Message security:** Zone-0/1/2 separation; content-script schemas separate and minimal (future); unknown kinds ignored not honored; no code-passing-as-data over messages. `[CI]`
- **S-05 Secrets:** none in repo (secret-scan CI); no third-party API keys in v1 (no cloud); any future key handling documented in threat model before merge.
- **S-06 Browser-API restraint:** forbidden by default: `history` (R6 law), `downloads`, host access, `cookies`. Each would break the privacy narrative *and* the trust perimeter; ADR-level event if ever proposed.
- **S-07 Supply chain:** dep policy §6 is the supply-chain policy; reproducible builds goal for store uploads; store-account 2FA custody documented; release signing as release-gate item.
- **S-08 Incidents:** security contact published; critical-severity (data exposure/execution) hotfix target ≤7 days with post-incident ADR-grade writeup added to docs within 14 days `[RITUAL]`; blameless, fix-forward.
- **S-09 Quarterly threat-model walkthrough** `[RITUAL]` — review EES §11 catalog against new code; log findings as DEBT items with owners.

---

# SECTION 9 — DOCUMENTATION RULES

**Update triggers (the doc gate):** `[CI]` where checkable, else review duty.
- New/changed **message contract** → contract registry entry + `v` bump note (same PR).
- New **event type** → event registry entry + upcast note (same PR).
- New **error code** → error catalog + copy keys (same PR).
- New **budget/constant** → constants registry + harness row (same PR).
- Changed **failure behavior** → Blueprint §9-table mirror doc + runbook touch (same PR or next-day follow-up DEBT item).
- **Migration** → migration doc + golden fixture (same PR).

**ADR triggers (mandatory):** any decision that is irreversible-ish; any new permission; any new egress endpoint; any change to durability/purge semantics; any new runtime dependency that *can't* be quarantined to one adapter; any change to sync/crypto/licensing shapes; any exception to A-01…A-16. If you're asking "does this need an ADR note?" during design — yes.

**Blueprint updates:** the Blueprint and ADR are locked corpora; amendments arrive as new ADR notes (ADR-047+) and a living "Blueprint delta" appendix file — never by editing history.

**Roadmap updates:** weekly burndown updates the *dates*; changes to *scope/gates* require TPM + Architect sign-off and a creep-log entry.

**README (30-minute law):** a new contributor must reach a running dev build in ≤30 minutes using only the README; tested annually with a real newcomer or clean VM `[RITUAL]`.

**Constitution maintenance:** amendment log append-only; document capped at ~present size — any addition must fit by deleting or merging something (P-06 applies to the constitution itself).

---

# SECTION 10 — TECHNICAL DEBT POLICY

- **Debt register:** every known debt is a `DEBT-###` item: description, why incurred, expiry, owner, reversibility class. Unregistered debt is treated as negligence, not debt. `[tracker]`
- **Allowed debt:** documented, reversible, timestamped, expires ≤2 releases; perf debt only while budgets green; scaffolding behind flags that have expiry lint passing.
- **Forbidden debt (delete-on-discovery, merge-blocker when introduced):** durability shortcuts of any size; purge-law violations; optimistic-truth UI; permissions creep; remote config; unowned TODOs older than one release; commented-out code; skipped tests without `EXPIRY`; "temporary" non-quarantined deps.
- **Refactoring policy:** refactors ship standalone (never mixed with behavior changes); large refactors (>1,000 lines) need a one-page plan + full gate run pre/post; the plan names the invariant proof that replaces review difficulty (property tests do the arguing).
- **Temporary code:** must carry `TEMP(YYYY-MM-DD, DEBT-id)`; lint fails past date `[CI]`.
- **Feature flags:** registry only (ADR-023); default-off for experiments; expiration at N+2 enforced by lint; no remote flags (A-10); flag-removed code paths deleted in the same PR that removes the flag.
- **Dead code:** deleted on sight (P-11); quarterly dead-code sweep with coverage/call-graph tooling `[RITUAL]`; `deprecated` markers require a removal date.

---

# SECTION 11 — RELEASE DISCIPLINE

- **Versioning:** SemVer for the extension; contract versions, event schemas, export majors each versioned independently per their registries (EES §3/§4/§5). Adding = minor; breaking internal contracts = minor with dual-read; export major bump = ADR (covenant).
- **Branches:** `main` is always releasable; feature branches short-lived (≤2 weeks); `release/x.y` stabilization branches live ≤7 days (cut, harden, tag, close).
- **Freezes:** per roadmap gates (v1 freeze at M4). Post-freeze: fixes + gate work only; "one tiny feature" is the most expensive sentence in software — auto-rejected by TPM ritual.
- **Rollback:** store-level: previous approved build kept resubmittable (Roadmap A10). Code-level: **revert-forward only** — main's history is never rewritten. Rollback rehearsal is a release-gate item (EES §8).
- **Emergency/hotfix law:** criteria: data loss risk, security incident, store rejection/blocker. Hotfix may expedite review (single senior reviewer) but may **not** skip: chaos suite (mutation paths), egress guard, dep audit. Post-hoc full review within 72h; test-seed for the defect lands with or immediately after the hotfix (T-01 exception codified — the only one).
- **Release manifest:** every release records: gate results, bundle sizes, perf numbers, dep list+audit, manifest diff, reviewer signatures `[GATE]`.

---

# SECTION 12 — LONG-TERM MAINTAINABILITY

**At 10,000 commits the project must still be:**
- **Fast to verify:** CI PR lane ≤10 minutes (test-budget discipline: suites earn their runtime or move to nightly); fixtures pruned annually; golden corpora versioned, not accreted.
- **Safe to change:** contract registries are the map; property tests are the argument; chaos points cover every mutation path ever shipped. The rule:regenerating confidence must cost minutes, not courage.

**At 100 contributors the project must still have:**
- **Ownership that scales:** CODEOWNERS per module; truth modules gated to senior owners; an ownership rotation each year so no module fossilizes under one person's departure `[RITUAL]`.
- **Onboarding that survives amnesia:** 30-minute law (§9) + "constitution first" reading order in onboarding; decisions live in ADR/debt register, *never* in chat history (chat-decisions are transcribed same-day or they don't count).
- **Principled welcoming:** junior contributors start in surfaces/docs/fixtures; truth-layer access is earned by demonstrated gate literacy, not tenure.

**At 5 years the project must still:**
- Run on boring tech where possible: yearly toolchain review against "could we replace this in a week?" (ADR-036 test).
- Keep its public covenants readable: export v1 files from launch year still open (covenant compliance test runs on legacy fixture files every release `[CI]`).
- Have headroom: budgets ≤70% consumed of their theoretical ceilings; if any budget is structurally exhausted, that's an ADR conversation, not a slow erosion.
- **Ritual calendar (permanent):** weekly — burndown vs gates + support digest; monthly — beta-channel matrix spot-check; quarterly — threat-model walkthrough + dead-code/dep sweep; annually — horizons review (parked ADRs), onboarding test, dependency renewal, constitution self-audit (§13 rerun).

---

# SECTION 13 — SELF AUDIT

*The constitution audits itself, because law that can't survive its own scrutiny deserves to be broken.*

## Contradictions found — and resolved
1. **T-01 test-first vs §11 hotfix speed.** *Resolved:* the hotfix law codifies the only exception (test-seed with/immediately post-fix, review ≤72h) — an enumerated exception, not a loophole.
2. **File budgets vs registry files** (event/error/copy catalogs will exceed 400 lines). *Resolved at source:* P-08/Section-2 exemption — single-purpose data tables exempt, logic may not hide in them (lint checks for functions in registry files).
3. **"Coverage floors" (T-02) vs "no coverage fetish."** *Clarified:* floors apply only to enumerated layers (invariants, domain, ports, messages); nothing else is measured — floors prevent cheating down, the absence of a global % prevents cheating up.
4. **Two-reviewer rule vs solo-team reality** (Roadmap sized 1–3). *Resolved:* the rule scales explicitly (≥2 reviewers when team ≥2; solo path = chaos+gate rerun+24h delay). An unscalable rule would have been the first one ignored.
5. **P-11 campground rule vs review-size limits** (drive-by cleanup inflates PRs). *Resolved:* separate-commit within PR for cleanups; cleanup touching untouched modules requires its own PR — keeps P-11 alive without breaking reviewability.

## Overly strict rules — softened deliberately
- File size 400 hard-block → *warn at 400, block at 800* (hard block would be route-around'd with uglier splits).
- Review SLA 48h → applies when team ≥2; solo cadence replaces with 24h self-re-review (already scaled in §5).
- Magic-number lint exempts tests *and* fixture literals (noise was predictable).

## Missing governance found — added
- **AI-generated code (2026 reality):** welcome, with three laws: the human author is fully accountable as if hand-written (all gates apply identically); generated fixtures/migrations get the same goldens review as human work; no AI tool may receive private repo content if it trains externally — tooling choice must satisfy the privacy taxonomy (ADR-020.
- **Experiment/spike governance:** spikes are allowed on non-main branches, timeboxed (≤5 days), and may merge only via normal gates rewritten as production PRs (no spike-direct merges).
- **Store-policy watch:** custody assigned (TPM) to watch CWS policy bulletins monthly — platform policy is an external dependency and belongs on the risk radar `[RITUAL]`.

## Rules most likely to be ignored — and the countermeasure
- *Docs-gate nags* → automated: registry-entry checks in CI wherever a registry exists; where uncheckable (runbooks), the alternative is a DEBT item created automatically by PR template checkbox — debt is visible, ignorance isn't.
- *PR-size limits* → CI labels (S/M/L/XL) + XL requires justification field; social pressure automated.
- *Comment quality* → not mechanically enforced (accepted); mitigated via review axis #7 and §2's lintable subset (no-commented-code, TODO-format).

## Maintenance risks to this document itself
- Bloat → size cap law (§9): additions fit only by deletion/merge.
- Dead ritual → every `[RITUAL]` has an artifact (minutes, reports) or it's deleted at the annual §13 rerun.
- Amendment drift → ≤2 rounds/year keeps the constitution boring — boring is how five-year-old law stays obeyed.

## Final simplification pass
Merged redundant logging/privacy rules into single lines; deleted two aspirational rules lacking enforcement (a "write good names" platitude and a generic "think about scale") — the constitution now contains **zero wishes**. Remaining rule count is deliberately static: any future rule must point to its enforcement mechanism or die in proposal.

---

*Ratified. Every contributor reads this before their first PR. The next document that may cite it is an amendment; the next artifacts that must obey it are all of them.*
