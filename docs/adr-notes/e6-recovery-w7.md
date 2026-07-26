# E6-T01 · W7 recovery flow + §14.4 card gating — decision record

Milestone: EPIC E6 (RECOVERY, DIAGNOSTICS, RESCUE — Tier 2), first work package.
Roadmap row: "Recovery card on loss-risk only (Blue §14.4) | deps E2-T07, E4-T06 | L |
Public beta | Real-restart e2e; exact catalog copy".
State: **shipped** (slices A–F). Evidences: unit 815/815, contract 44 pass + 4 skip,
e2e lane 2/2 green on real Chromium 151.0.7922.47.

---

## Q1 — the wire needed two new names. Amend the frozen §3 registry?

**Decision:** amend with exactly two additive rows: `RestoreBootSession` (command,
29→30) and `GetBootReport` (query, 8→9). Census now 30 commands / 9 queries /
13 streams / 17 workroom / 5 sync; both new rows pinned by the census test,
handlers-parity NEVER_AUTO_RETRY_WIRE and contract-compat payload fixtures, each
with this note cited in-place.

**Ruling (verbatim by substance):** wire-amendments → `amend-two-rows` — "Amend
with the two additive rows (recommended)".

**Why:** the §3.5 stream `RecoveryAvailable` was pre-frozen, but the card's render
and act had no wire carriers. Additive rows keep the frozen surface closed under
the census law (counts move explicitly) while the discovery window for the DTO was
the card's own venue: fire-and-forget stream ⇒ hint only; the surface re-queries
`GetBootReport` and gates on the returned DTO's `pending` flag (§14.4 gate rides
server-truth, never the hint). `RestoreBootSession` puts back server-side because
surfaces are authority-free — the per-mission expansion lives in the usecase.

---

## Q2 — what actually flips loss-risk at a real crash (the card's §14.4 input)?

**Decision (WP6 law, unchanged):** `assessLossRisk = probe-fail | deferred |
aborted-conservative-with-evidence`; degraded ⇒ loss-risk by definition (scope
unknown). The card opens only when severity is `loss-risk`; `clean-abnormal`
announces on the guardian chip (`msg.heartbeat.recovered`) with NO card.

**Taxonomy discovered at real-boot evidence (e2e, this task):** the FIRST boot of
a fresh profile classifies `cause: 'first-run', abnormal: false` — install is NOT
an announced incident. The first ANNOUNCED incident on any profile is the first
abnormal restart (crash-classified end while the same build ran, or update).
`warm-recycle`/`first-run`/`undetectable` stay silent (Marker taxonomy: "no copy
path"). The e2e scenarios were authored against this measured truth, not the
install assumption this task started with.

---

## Q3 — how does the real-restart e2e force a deterministic loss-risk on a real

browser, with the real leveldb?

**Decision:** scenario A plants ONE dangling universal-kind intent
(`kind: 'RescueScanNow'`, no lawful abort row ⇒ reconciler defers ⇒ loss-risk)
plus one live mission with three live tab rows (the put-back scope) directly into
the extension's real IDB between an install-boot and a REAL `SIGKILL`; the
relaunch's boot act (classify → reconcile → slot → announce → venue) then runs
entirely in product code. Plan B (byte-corrupting the leveldb tail) was REJECTED
on analysis: leveldb writes are transaction-atomic, replays skip-and-resync past
corrupt records, and last-write-wins rewrites the same keys each append — a tail
flip reverts to a consistent older prefix in the overwhelmingly common case, so
probe-fail is NOT deterministic. The seeded-intent seam mirrors the unit lane's
canon (roots.test plants the same row shape) and is deterministic under every
crash ordering.

**Why this is a lawful harness act:** seeding is a precondition write (three
stores, one IDB txn), exactly what the marker/journal chaos harness does against
the memory engine; every action after the rows land — classification, resolution,
announce, card, put-back, settle — is product behaviour alone in a real browser.

**Constraint discovered:** black-box wire traffic cannot create these rows today —
the ingest tier (chrome tab-event → hub) is the E3 adapters milestone, so `tabs`
projection rows and park-intents have no wire path yet. Import commits land as
`'kept'` rows (spec W15 exile = kept-not-open), outside the put-back `live`
filter. Direct IDB seeding was therefore the ONLY precondition path; the card's
scope counts (`3 tabs · 1 missions`) prove scope ≡ put-back set against it.

---

## Q4 — lane shape and scheduling?

**Decision:** vitest project `e2e` (include `ops/tests/e2e/**`), forks/singleFork,
fileParallelism off, testTimeout/hookTimeout 240s as the DECLARED long-running
exception to the 60s single-test house law; NOT in default `pnpm test` (unit
project-scoped by law) and NOT in `ci:all` today — per the user ruling and the
EES §6 e2e line ("puppeteer-class, load-unpacked, PR-blocking smoke + full
nightly"), CI wiring is the lane's own row.

**Ruling (verbatim by substance):** e2e-lane → `build-and-run` — "Build lane + run
once here to green (recommended)", with the two scenarios: SIGKILL ⇒ card + exact
copy, graceful ⇒ no card; declared long-running, not wired into `pnpm test`.

**Mechanics recorded for the next lane builder:**

- Chrome: `@puppeteer/browsers` install to `$TMPDIR/ledge-chrome` (env
  `LEDGE_CHROME` overrides); minimal containers satisfy `ldd` via apt `.deb`
  extraction under `$TMPDIR/ledge-libs` + `LD_LIBRARY_PATH` (zero-root).
- The page-side client bundle REUSES the real surface wire client
  (`createWireClient` + cid minter) so the harness speaks the frozen §3.1
  envelope; built by `scripts/e2e-client-build.mjs` from the pnpm store's pinned
  esbuild (transitive dep — its bin is not linked; it must not become a direct
  devDependency for one test script); output `ops/tests/e2e/client.js` is
  gitignored + eslint-ignored (generated artifact).
- MV3 extension-page CSP forbids inline `<script>`: the bundle is injected via
  CDP `Runtime.evaluate` (the privileged devtools channel), never the page parser.
- Unpacked-extension ids are a pure function of the extension's absolute path
  (sha256, a–p nibbles) — the harness derives the id before any SW exists.
- Exact copy is asserted template-anchored against `catalog.json` (literals exact,
  parameters wildcarded) — a copy drift breaks the lane in the exact place it
  drifts. Disclosure notes asserted verbatim: `note-deferred`, `note-crosscheck`,
  `note-marker-gap` rendered for the seeded damage class.
- Put-back assertion rides real browser targets: three `127.0.0.1` fixture tabs
  must reappear with exactly the seeded URLs (one new window, focused), then the
  resolved line (`msg.recovery.restored`) and the settled slot (`pending:false`).

---

## Q5 — sandbox incident recorded for the history

Mid-task the sandbox's `.git` state rolled back to a stale tip (objects for the
local-only commits `dda5c3f` and `5d8dc19` vanished; worktree untouched). The two
commits were reconstructed from the surviving worktree as `6c6db9a` (E1
load-unpacked verifier) and `2838249` (WP7 slices A–D), re-verified: unit 815/815,
contract 44 + 4 skip, tsc/eslint/prettier/depcruise green. Two latent lint errors
in the reconstructed test file were fixed in the e2e slice's commit alongside
(visible only because the reconstruction replayed the full gate battery). The BOM
fixture byte-law caught the same rollback's corpus drift (`git restore` healed it
byte-exact) — the .gitattributes `-text` tripwire did its job.

---

## Follow-ups (registered, not worked here)

- **E6-T02** (sessions cross-check UI; deps E3-T03, E6-T01): wiring a real
  crosscheck removes the permanent `crosscheck-degraded` disclosure token and its
  note from every announced incident.
- **E6-T03** (diagnostics ring): boot-act faults currently degrade silently by
  law (never take the graph down) — the ring is the telemetry venue for
  reconcile/record errors.
- **Relative-time tier**: the card's `{asOf}` rendering (`just now` / `N min before`
  / `N hr before` / clock time >1 day) is a first cut; a tiering review belongs to
  the UX copy pass.
- **Guardian demand-card venue**: the guardian renders both severities (chip vs
  card class) but v1's auto-card venue is the quiet tab only (§5.9 single-tab
  law); an on-demand card entry point is an E6-T02-era UX question.
- **E2E on CI**: PR-blocking smoke + nightly job per the EES line (env
  `LEDGE_CHROME`, build profiles in tmp; lane is green here at ~21s total).
- **Deterministic probe-fail future**: if a corruption-class e2e is ever wanted,
  it needs SST-level multi-offset corruption or a flagged fault-injection build —
  plain tail flips are provably nondeterministic (Q3).
- **Platform note pending ruling (from the E1 deliverables report):** Chrome caps
  _suggested_ shortcuts at 4 vs the frozen 6 defaults (§5.3) — needs a ruling when
  the E3/E4 command lanes land.
