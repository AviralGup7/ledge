# E6-T02 · sessions cross-check UI (candidates panel) — decision record

Milestone: EPIC E6 (RECOVERY, DIAGNOSTICS, RESCUE — Tier 2), second work package.
Roadmap row: "Sessions cross-check UI | chrome.sessions reconcile candidates |
deps E3-T03, E6-T01 | M | recovery crosscheck panel | Confirm-before-restore law".
State: in flight. Frozen anchors: EES §2.13 step 5 (NativeSessionsPort cross-check,
read-only, E_CAPABILITY ⇒ degrade with logged gap), Blueprint §6.7 (boot reconcile
reaches the sessions backlog BEFORE the card), W7 failure law ("restored to 2:41
pm; 3 tabs after that may be in Recently Closed").

---

## F1 — what is a candidate? → `unmatched-only`

**Ruling (verbatim by substance):** candidates are the browser's Recently Closed
backlog rows whose URL matches NO journal live-scope row; matched rows silently
confirm the scope (they are evidence the journal is right, not restore material).

**Why:** the scope the put-back reopens comes from the journal (truth). A backlog
row the journal already accounts for carries zero decision value on the card;
showing it would invite double-opens. Implemented as the pure law
`crossCheckCandidatesOf(backlog, scopeUrls)` — exact-URL diff, dedupe keep-first
(backlog is most-recent-first), capped at `MAX_CROSSCHECK_CANDIDATES = 25` (the
platform ceiling EES §2.13 names; the snapshot stays bounded in storage).

---

## F2 — how do candidates restore? → `extend-restore`

**Ruling (verbatim by substance):** extend `RestoreBootSession` — additive-optional
`includeCandidates: urls[]` payload, response gains `candidatesRestored?: number`;
candidates open as **plain new tabs, never mission-formed**, one act / one settle
story.

Laws implemented:

- **Confirm-before-restore (the row's completion gate):** the quiet card's panel
  defaults every candidate EXCLUDED; only toggled-in urls ride the payload. An
  untoggled put-back sends an explicit empty list (never implied intent).
- **Authority posture:** the service intersects the request with the STORED
  snapshot — surfaces are authority-free, so only urls that were actually
  snapshotted are lawful picks; stranger urls are filtered, never refused-at-
  large (counts answer truthfully).
- **Bounded both ways:** includeCandidates > 25 ⇒ `E_DOMAIN_LEGALITY` refusal
  `candidates-over-limit`; any empty-string element ⇒ `candidates-invalid`.
  Both refusals land BEFORE the durable claim and BEFORE any browser move.
- **One trailing window, calm arrival:** candidate tabs open in a single window,
  `focused: true` ONLY when no mission window preceded it (never steals the
  current browsing focus — the mission loop's calm-arrival rule carries over).
- **Dedupe:** picks skip urls this act already reopened (scope drift: a row live
  again between snapshot and put-back must open once, not twice).
- **Settle semantics unchanged:** a candidate-window failure discloses
  `restore-failed` and keeps the incident pending (retry lawful); mints NO
  intent facts (ResumeAccepted stays mission-scoped).
- **Census untouched:** same wire name; payload/response change is
  additive-optional — older fixtures and older sends stand.

---

## F3 — when are candidates computed? → snapshot-at-incident-creation

(AMENDED — supersedes the earlier `live-requery` ruling)

**Ruling (verbatim by substance):** "Compute the candidate set once during boot
incident creation, store it in the boot incident slot (bounded ≤25), and never
mutate it afterward. The recovery card always represents the exact browser state
observed during that boot's recovery analysis. Subsequent browsing or later boots
create new incidents rather than changing the existing one."

Why the amendment stands: a live re-query would let later browsing quietly
rewrite what the card offers to restore — the confirm the user reads must be the
confirm that executes. Snapshot-at-creation makes the DTO a pure slot read.

Laws implemented:

- `recordBoot` computes the snapshot EXACTLY ONCE, only for ANNOUNCED incidents
  (silent slots have no card path — no read is even attempted). It rides the
  same live-scope inventory the slot is about to describe.
- **Merge law synergy (already shipped E6-T01):** a new incident supersedes the
  slot with its OWN fresh snapshot; a pending incident is never clobbered by a
  non-incident report — snapshots die only with their incident.
- **Never-mutate:** `getBootReport` is a slot read; `restoreBootSession` never
  prunes the stored set (post-settle the snapshot stands as the incident's
  record).
- **Documented divergence:** `scope.tabsRecoverable/missionsAffected` stay
  TRUTH-NOW (what the put-back would restore now), while `crossCheckCandidates`
  is boot-TIME (what that boot observed). Both are labeled truths, not one.
- **Degrade law (EES §2.13):** seam unwired or E_CAPABILITY ⇒ no snapshot key is
  stored; the incident records and the boot act never faults (the report's
  crossCheck token already discloses a degraded seam). Card hides the panel on
  absent or empty snapshots.
- **Slot schema stays v1:** `candidates` rides additive-optional with a
  structural read guard (malformed rows drop per §2.9, url-less rows are noise
  not evidence). Bumping `BOOT_SLOT_SCHEMA_V` would make the forward-tolerance
  read treat a PRE-WIDENING pending incident as absent — orphaning a user's
  unrestored crash, which W7 cannot allow.

---

## Wire census (unchanged — amendment-only, per E6-T01 census law)

`GetBootReport`: DTO gains additive-optional `crossCheckCandidates` (payload
spec unchanged; older readers stand). `RestoreBootSession`: payload gains
`'includeCandidates?': { array: 'string' }`, response gains
`'candidatesRestored?': 'int'`. Counts stay 30 commands / 9 queries / 13 streams /
17 workroom / 5 sync — both registry rows cite this note in-place.

## Copy census (catalog additions, msg.\* grammar)

- `msg.recovery.candidates-head` — "{count} recently closed pages could be
  added to the put-back."
- `msg.action.include-candidate` — "Add to put-back"
- `msg.action.exclude-candidate` — "Leave out"

No pressure lexicon; calm-factual register; exact-template e2e anchors ride the
same keys.

## Evidence

- Unit: recovery cross-check block (pure diff law, snapshot/immutability,
  degrade, confirm-before-restore, authority filter, drift dedupe, legality
  refusals pre-claim, failure-leaves-pending, forward tolerance) + quiet panel
  block (snapshot render/hide, toggle arming, payload shape) — unit lane
  827/827; contract lane 51 pass + 5 skip (payload fixtures: additive-tolerant,
  old shapes pass unchanged).
- e2e (real-browser lane, Slice E — in flight at this checkpoint): scenario A
  extension — a real Recently Closed row closed BEFORE the SIGKILL should arrive
  in the next boot's snapshot, panel-visible after relaunch, toggle-in ⇒
  put-back opens it as a plain extra tab. (chrome.sessions persistence across a
  hard kill is observable, not contractual — the unit lane owns the LAW proofs;
  the e2e row proves the FLOW on real Chromium.)
