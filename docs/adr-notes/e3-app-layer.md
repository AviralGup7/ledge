# ADR note — E3-APP Application Layer decision record

**Status:** accumulation of route-level decisions taken while building the E3-APP
Application Layer (services, command/query buses, DTO/result mapping, outbox,
composition wiring). No ADR reversals; every item composes within ADR-005
(single-writer), ADR-007 (listener-first activation), ADR-010 (frozen dual-read
contract window), ADR-020 (purge/compaction family), ADR-026 (typed `LedgeError`
everywhere). **Authored:** 2026-07-26, E3-APP close-out.

This note exists so no decision below lives only in a commit message or an
inline comment. Each entry: the question, the decision, the why. Items marked
**[follow-up]** name the milestone that owns the remaining work.

---

## 1. Park lifecycle

### 1.1 Park two-phase projection law (ack ⇒ durable ⇒ views, per phase)

Blueprint §6.4 sequences park as snapshot → Txn A (ack batch: `SnapshotTaken`,
`MissionFormed`, `ParkIntentAccepted`) → close tabs → completion. The first
implementation rode the intent ledger's foreign append inside `withStampLock`,
which advances the stamping memo but **returns before projections are driven** —
the ack batch stayed unprojected, and the completion `TabAssigned` then rode the
missions projector's forward-tolerance into a provisional `live` row that masked
the skip and broke the C7 open-check.

**Decision:** every phase of park drives projections itself before moving on
(`applyProjections` after the accept batch, inside `parkScope`). Law: within one
use case, _ack ⇒ durable ⇒ views_ is per-phase, never per-use-case — a later
phase must see the earlier phase's views exactly as a reader would.
**Regression-pinned:** `ops/tests/unit/application/park.test.ts`.

### 1.2 Park target law: majority non-trash binding, else form

Parking tabs that already belong to missions targets the mission binding the
**majority of non-trashed tabs**; otherwise park forms a new mission with
`provenance: 'park'` and name = leading domain of the parked set, else
`'Parked mission'`. Rationale: park is a user-visible grouping act — silently
splitting a set whose majority already has a home would violate the W1/W16
mental model; silently merging a homeless set into an arbitrary mission would
invent grouping the user never made.

### 1.3 ParkAll per-sweep cid discriminator

ParkAll sweeps once per window; every per-window sweep originally shared the
parent cid, so the ledger's cid-dedupe rejected sweep 2+ as
`intent-already-accepted`. **Decision:** `parkScope` takes a
`sweepDiscriminator`; per-window cids are `${parentCid}-s${index}`. Dedupe
correctness is unchanged (the discriminator is deterministic per sweep), and
each sweep is independently retryable. **Regression-pinned** in `park.test.ts`.

### 1.4 Abort-revert view gap ⇒ conservative parked

If park fails after Txn A but before completion, the intent row is already
`done` from the ledger's perspective; the view cannot be honestly rewound.
**Decision:** the failed park leaves the mission conservatively **parked**
(durable truth), the command fails with the honest typed error, and undo =
`resume` (park is deliberately absent from the undo stack — its inverse is a
first-class command, not an atom).

### 1.5 ParkAll rate law

C6: `ParkAll` in the maintenance lane sheds with `E_RATE_LANESHED` on pressure;
`meta['parkAll.lastAt']` stamps only after a completed sweep (never on sheds —
a shed must not suppress the next honest attempt).

---

## 2. Resume / undo carriers

### 2.1 Unarchive & merge-undo ride an empty-partial `MissionResumed`

`MissionResumed` is the only lifecycle event that materializes a mission view
row back to `live`. Unarchive and merge-back/split undo need exactly that
view transition with **no tab restoration**. **Decision:** they emit
`MissionResumed` with `restoredMapping: { plannedTabIds: [] }` — an explicit
empty plan, distinguishable from a real resume, and safe for every projector
that pattern-matches on plan length. No new event name was minted (registry
additions are contract work, not application work).

### 2.2 Resume C7 live-check never creates windows

A resume whose C7 live-check finds the binding window still open reports
`{ windowId: binding?, restored: 0, moved: 0 }` and does **not** create a
browser window. Durable accept runs through `StreamAppender.commit` (internal
apply included) so the ack batch is projected before any browser call —
mirrors 1.1's law onto §6.5.

### 2.3 Undo currency: `'stack-moved'`

Undo is a stack-machine act, not a journal lookup: `undo()` returns
`{ undid: label }` where the label is the §3.2 copy-catalog key
(`msg.undo.renamed`, cascade `msg.undo.trashed-mission`, …) of the atom that
moved. Asking "what did undo do" is answered by the pop, not by projecting
history — the honest currency of a LIFO truth. Redo is
`redo-unscoped-v1` (`E_CAPABILITY`): v1 has no scoped redo design.

### 2.4 Undo-stack carriers

Rename pushes `rename-mission`; merge pushes `split-merged` (undo = Split);
split pushes `merge-back`; move pushes `move-back`; archive pushes `unarchive`;
trash-cascade pushes `restore-cascade`; import pushes `import-undo`
(R11: undo of an ImportCommit = an `EntityTrashed` batch with
`bulkId = batchId`). Cap 20, meta key `undoStack`.

### 2.5 Gate laws C15/C17

Merge/Split are confirm-gated: the first dispatch returns the confirm
requirement; only a payload carrying the confirm token executes. Deleting a
mission (trash) is confirm-gated the same way; both lanes are exercised in
`missions-trash-undo.test.ts`.

---

## 3. Missions, trash, conclude

### 3.1 Conclude shape

Conclude is legal only from `parked | archived`
(refusal `conclude-requires-parked-or-archived`, mapped into
`E_DOMAIN_LEGALITY`). It emits `MissionConcluded` (with trimmed
`outcomeNote`) + `MissionArchived`, and pushes **no** undo atom — conclude is
terminal by product law, so inventing an inverse would lie.

### 3.2 Conclude-flag is sticky

Once concluded, the flag is never cleared by later events (unarchive does not
un-conclude). **Decision:** stickiness lives in the projector read, not in an
extra event — v1 ships no "unconclude" path rather than a half-specified one.

### 3.3 Mission-missing folds into `E_DOMAIN_LEGALITY`

An operation against a mission id that does not exist is reported as
`E_DOMAIN_LEGALITY { operation, reason }`, not a bespoke `E_NOT_FOUND_MISSION`:
the surfaces' copy matrix already keys on legality failures for
gone-mid-flight targets, and one code keeps the error map total.

### 3.4 Close-content limitation **[follow-up: rc projector growth]**

Rows for tabs closed _externally_ (browser-side) are content-free in v1: the
`recently_closed` projector does not yet harvest last-known content into the
row. `CloseTabs`-driven closes carry full content. The projector-growth item
is tracked against the projections milestone.

### 3.5 Trash purge indexing

`TrashPurged` is emitted **per entry** (singular truths), with
`purgeEpoch = baseline + 1`. The v1.1 sweep composes with ADR-020 compaction
unchanged.

---

## 4. Identity correlation and ingest

### 4.1 Ingest ↔ resume identity correlation is row-local

Resume correlates ingested observations to planned tabs via the row's
`browserTabId` (the durable identity carried on `TabObserved`), never via
ephemeral chrome ids held in memory. SW death between observe and resume
loses nothing recoverable.

### 4.2 Ingest/appender stamping convergence **[follow-up]**

The ingest hub stamps through its own seam today; converging it onto the
StreamAppender stamping authority (one per-graph stamper law) remains open,
tracked against the browser-adapters milestone.

### 4.3 Ingestion activation is the browser-adapters milestone

The root builds a real `createIngestHub` by default, but wiring
`chrome.tabs.on*` events into it is deliberately **not** E3-APP scope (the
roadmap's "E3" browser-adapters tier owns it; code marker `E3-APP` keeps the
collision explicit).

---

## 5. Outbox / §3.5 stream naming

### 5.1 Wire watermark scalar is `seq` (v1)

`ViewDelta` carries `watermark: number`; the positioned `{deviceId, seq,
batchIndex}` is reduced to `seq` at the only emit site. Consumers learn a
monotonic scalar; the positioned truth stays journal-side where gap/death
analysis actually needs it.

### 5.2 CommandAck rides only real intent ids

`CommandAck` is emitted only when `isId(intentId)` holds — synthetic family
tokens (`ack:*` fallbacks) never ride the wire, so surfaces can treat every
received ack id as ledger-resolvable.

### 5.3 Progress family gating

`Import*`/`Export*` progress frames ride the wire only when their ref is a
real `Id`; bus-only otherwise. Cancellation has **no** carrier in v1 (surfaces
learn cancellation from the terminal, not from a stream).

### 5.4 ExportReady waits for E5 fetch material **[follow-up: E5]**

`ExportReady` emits only when the result carries `fetchURL + manifestId +
chunkChecksums`; v1 export answers `E_CAPABILITY` honestly until the
portability milestone lands the fetch material.

### 5.5 ResyncRequired ownership

Gap/death detection and `ResyncRequired` emission are recovery-owned
(`reason: 'schema'` is the only outbox-emitted resync, fired when a view
regresses). The outbox never invents gap semantics.

### 5.6 R10 Heartbeat coalescing

Heartbeat frames are post-applied and coalesced (one in-flight + one
trailing) — a busy SW never emits a heartbeat storm, and a quiet SW never
emits a stale one.

---

## 6. Tier-2 internal surface

### 6.1 Internal validation design

Internal Tier-2 names (Recent Activity, favorites, redo, topic teaching) have
no §3 wire-registry rows by law — the frozen registry is the _wire_ contract,
and these names never ride it. **Decision:** `validateInternalMessage` applies
the identical envelope-shape laws (version, kind, cid, senderContext,
contractHash, payload caps, zone-1 refusal) against an explicit **roster**;
unknown names ignore, kind-side lies reject, payloads pass through
un-normalized — the handler registration is the typed seam. Dispatchers opt in
via `deps.internal`; the composition root routes by registry membership; the
parity law (`handlers.parity.test.ts`) proves wire ∩ internal = ∅.

### 6.2 Favorites / pins are settings-carried

Favorite state rides `settings` keys `favorite.<mission|tab>.<id>`; pinned
missions ride `pinnedMission.<id>` — both inside the `SETTINGS_WHITELIST` +
prefix law, so they inherit settings' durability, sync posture, and reset
semantics without a new store.

---

## 7. Queries / views

### 7.1 Search freshness `'fallback'` **[follow-up: Tier-3 index]**

`SearchResultsView` reports `freshness: 'fallback'` with searched scopes; v1
search is a projections-scan (multi-term AND, limit ≤ 50) until the Tier-3
search index milestone lands.

### 7.2 `memory_artifacts` has no v1 projector

`getMissionDetail` reads
`memory_artifacts.byIndex('[subjectId+kind]', [missionId, 'topic'])` and
returns honest-empty topics in v1: no projector materializes that store yet,
and faking topics would violate the honesty law.

### 7.3 HeartbeatView semantics

`keptCount` = KEPT tabs, `liveRecoverable` = LIVE tabs, `asOf` stamps the
read — surfaces render "what park protects" without reaching into aggregates.

### 7.4 `peekOpenTabs` is browser-side

Open-tab peek queries are served from `tabs.query` (the browser), never from
projected rows — rows are historical truth; "open right now" is a browser
claim.

### 7.5 GetBootstrap surface enum

Bootstrap payloads validate `surface ∈ guardian | overlay | quiet` —
`'sidepanel'` is rejected (the surfaces' names are the contract's names).

---

## 8. Portability

### 8.1 ImportPreview journalled, entity-free

`ImportPreviewRequest` **does** journal `ImportPreviewed` (audit law: previews
are user-visible decisions) but writes **zero** entity rows; consumers of all
views see only `ImportCommitted`.

### 8.2 ImportCommit lands PARKED

Imported missions materialize `parked` with `namedBy: 'import'`, tabs kept;
the undo atom is the R11 import-undo batch (see 2.4).

### 8.3 Importer/exporter are root-injected seams

Unwired in v1 ⇒ services answer honest `E_CAPABILITY`; the composition test
(`runtime-graph.test.ts`) pins the seam.

---

## 9. System / preferences

### 9.1 `forgetEverything` purge scope

Purges `memory_artifacts`, `search_index`, `dupe_index` **only**; journals
`MemoryWiped`; settings and lifecycle views survive. Wording mirrors the
surface copy exactly — "everything" is the _memory_ everything.

### 9.2 Rescue scan report identity

`rescueScanNow` appends a ring-log row of `kind: 'scan'` and reports
`reportId = diag.scan:<ts>:<id>` — resolvable without a new store.

### 9.3 First-run ingest

`firstRunIngest` ingests, then forms **one** `MissionFormed` per windowId
bucket (name = active tab's domain, else `'First window'`; provenance
`'first-run'`), resend-guarded by the ingest-report flag — a SW restart
mid-first-run cannot double-form.

---

## 10. Dispatcher / hub

### 10.1 Cached cid replays terminal, never re-executes

A cid seen post-terminal resolves `ack` + republishes the recorded terminal
on the bus (surfaces that re-ask after a transport gap get the same truth);
the handler is never re-executed.

### 10.2 SnapshotBuild trigger carried end-to-end (regression)

The port interface carries §4's required `trigger`; the adapter + test fakes
emit it, so `sessions` rows carry the §5 trigger vocabulary. Bytes from
pre-vocab snapshots normalize to `'auto'` at the read seam (snapshots
adapter). **Regression-pinned.**

### 10.3 Replay mirror totality (regression)

The `replay-purge-law` property mirror is now total over `ViewName` with an
exhaustive `pkOf` (`missions→missionId`, `tabs→ledgeTabId`,
`sessions→snapshotId`, `recentlyClosed→entryId`); a `tabs` frame can never
again land phantom rows on the recently-closed shelf (CI seed `-1953314806`
is pinned as a sub-second `it` inside the property file).

---

## Consequences

- Application surfaces consume exactly one dispatch entry per registry; the
  root is the only assembly site, so the dependency-law line
  (UI ⇄ Application ⇄ Domain ⇄ Infrastructure) has one enforcement edge.
- Every stream name on the wire traces to §3.5; every refusal above traces to
  a typed `LedgeError` code already in the surfaces' copy matrix — no new
  surface-facing strings were minted in E3-APP.
- Follow-ups are milestone-owned: E5 export fetch material, Tier-3 search
  index, rc projector content growth, ingest stamping convergence, and
  chrome-event ingestion activation (browser-adapters tier).
