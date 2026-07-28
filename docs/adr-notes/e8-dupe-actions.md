# E8-T07 · Dupe detection v2 + actions — decision record

Milestone: EPIC E8 (AI lanes), seventh work package. Roadmap row: "E8-T07
Dupe detection v2 + actions | Markers→one-tap actions (opt-in law) | E5-T02 |
M | guardian dupe strip | No silent closing (spec) — action tests". Frozen
anchors: Spec lane law "the lane dedupes open duplicates (marks, does not
close)" (§ duplicate detection, v1.1 table row ⏳), ADR-035 settings LWW
carrier, A-09 append-only events, E1-T06 canon v1 (conservative matching),
EES §2.12 op-key idempotence, the quiet posture.

No design forks escalated: the row's criterion IS the design law; the
rulings below pin legality answers, idempotence shape, and the dismiss
carrier, which the row left to engineering.

## D-series rulings

- **D1 · Parking is the ONLY closing vocabulary.** The spec bars silent
  closing absolutely, and Ledge's settled word for a user-reversible
  removal is _park_ (the parking-lot doctrine). The one-tap action parks
  exactly the older copies of a group; it never "closes", never "cleans
  up", never touches the keep tab. "Close duplicates" is not a wire name,
  a copy word, or a code path.
- **D2 · The keep pick is a reading-freshness fact, not a preference.**
  Keep = maximum `lastActiveAt`, tie broken by lexicographic ledgeTabId
  (deterministic, no randomness). Rationale: the tab the user was most
  recently looking at is the one whose scroll position, form state and
  mental context are live; parking it would destroy real state. Candidates
  sort oldest-first so the park loop retires the stalest evidence first.
- **D3 · Act-on-now truth: every action re-derives.** `parkDupeGroup`
  never trusts the caller's group view. It re-reads live tabs, re-groups
  by `canonHash`, and refuses with `E_DOMAIN_LEGALITY{reason:'group-gone'}`
  when the group dissolved, or `reason:'keep-moved'` when the keep pick
  changed since the strip rendered. A stale strip must produce a calm
  refusal, never a stale write. (A3/A4 pin this.)
- **D4 · Convergent idempotence.** The park loop mints one operation-key
  per tab (`${cid}:${index}`), checks cancellation before each gesture,
  and treats `E_NOT_FOUND_TAB` as _already converged_ — the tab is gone,
  which is the goal state — deducting nothing and erroring nothing
  (redelivery under at-least-once transports must be invisible). Any other
  fault surfaces honestly at first error with earlier parks standing
  (partial state is reported, not rolled back: parking is a set of
  independent lawful acts, not a transaction). A5/A6 pin both halves.
- **D5 · Dismiss rides the settings carrier (ADR-035), NOT the event
  journal.** `dupeIgnore.<canonHash>` is a UI-level relief preference —
  cheap, revocable, and last-write-wins by nature — so it travels as a
  `SettingsChanged` op keyed `DupeIgnore`, exactly like other surface
  toggles. This is deliberately unlike E8-T05's `BriefDismissed` JOURNAL
  event: a brief dismissal is _memory truth_ the gates read (J4
  preference-not-deletion, part of the story the device tells about the
  user), whereas a dupe-strip dismissal gates nothing but one widget's
  next render. Memory reads settings either way; the journal is reserved
  for facts the MEMORY ITSELF must never lose.
- **D6 · Detection is re-derived, never stored.** Groups are computed from
  live tab rows on every pull via canon v1 — there is no `dupes` store, no
  snapshot event, no migration burden. Consequence: when canon rules bump
  (tracking-denylist growth), re-grouping is honest automatically, and
  ignore keys stay valid because they are hash-keyed to the same rules
  version that produced them (a rules bump dissolves stale ignore keys
  quietly — groups reform under new hashes; acceptable: revoking a
  dismiss is a small surplus of relief offered, never a wrong action).
- **D7 · The strip is capped at 5 rows, relief-ordered.** Groups sort by
  candidate count descending (most relief first per the sprawl
  doctrine), tie-broken by hash ascending for determinism, capped at
  `DUPE_GROUP_STRIP_CAP = 5`. The guardian is a window, not a database
  dump; five honest offers beat forty.
- **D8 · Opt-in law is mechanical, not aspirational.** The guardian seam
  has exactly one mutating member, `park`, and the widget is wired so the
  ONLY call site is the tap handler. D7-2 pins zero calls before the tap
  and exactly one call after; D7-3 pins dismiss never touching the park
  seam. "No silent closing" is therefore a test-enforced structural fact,
  not a code-review hope.
- **D9 · v1.1 wire reserved dormant.** `ParkDupeTabs`, `IgnoreDupeGroup`
  (commands) and `GetDupeGroups` (query) are registered at availability
  `v1.1` with frozen shapes; today validation answers `unavailable-name`
  and the composition root injects the application service directly into
  the guardian seam. When the tier flips, the wire rows activate with zero
  shape drift — the same reserve pattern as the E8-T05 brief wire.

## Boundaries explicitly NOT taken

- No heuristic/AI re-ranking of dupe rows (groups are a pure function of
  canon+time; AI has no evidence to add).
- No auto-park suggestion ("you always park these") — that is a memory
  proposition for a later milestone, gated by its own ADR note.
- No cross-window merge offers, no pin/freeze gestures on the strip.
