# ADR note — E5-T06 Import preview UI (quiet-page panel + bytes shelf)

Status: shipped (E5 milestone, closes the epic with E5-T05). Companion notes:
`e5-importers.md` (parser family, WP5), `e5-export-format.md` (covenant, WP3).
This note records two **user-ruled contract decisions** (frozen-vs-roadmap conflict,
paused and asked per governance) and the design decisions that followed.

## 1. The conflict (paused, asked, ruled)

Roadmap E5-T06 demands "Counts/dupes/rejects display w/ commit flow" and product spec
W15 demands "Preview before commit (counts, detected structure)". But under the frozen
contracts the preview **census had no lawful wire path** to a surface:

- C20 payload frozen to `{fileMeta, parserHint}` (its own comment: "bytes move through
  the workroom streaming contract"); C20 response `{previewId}` only.
- `ImportReady` stream frozen to `{previewId}` only.
- Response extras are **stripped, not tolerated** (envelope §3.1c), so smuggling the
  census inside an existing response was impossible by construction.

Two questions went to the user; both rulings recorded here verbatim-by-substance.

## 2. Ruling A: amend `ImportReady` to carry `modelSummary`

**Decision.** The frozen stream row gains an additive field:
`ImportReady {previewId, modelSummary}` — one-row registry diff; contract hash
recomputes (dynamic via `computeContractHash()`, no pinned literal broke; contract
lane green in the same commit).
**Mechanism.** `PortabilityService.importPreview`'s return became a superset
(`{previewId, modelSummary}`); the outbox lifts the summary from the applied result
into the stream emission, guarded (`isId` + string check — the ExportReady emission
pattern). The wire response row stays `{previewId}`: the registry answer is the
requester's terminal, the stream is every surface's material. The `modelSummary`
shape key (`<parserId>:m<n>:t<n>:r<n>:d<n>`, WP5 law) is exactly what its registry
comment promised — surface-facing structural material, never display copy.
**Why this over the alternatives.** (a) A page-side transient-journal reader would
have honored the "(transient surface only)" consumer note literally but invents a
second surface data channel with open-connection/version-skew hazards; (b) deferring
counts to post-commit violates W15's preview-before-commit law outright.

## 3. Ruling B: bytes stage through a shared-origin IDB shelf

**Decision.** v1 bytes transport = a shared IndexedDB shelf (db `ledge-import-stage`,
one `pending` store, one `latest` slot) implementing the C20 comment's "workroom
streaming contract" as its honest v1 frame. The frozen wire carries `fileMeta` only;
`PortabilityService.importPreview` resolves a bytesRef-less request against the
shelf (`takeMatching`) before invoking the importer. When the parked offscreen
workroom (§3.6 `ParseRequest`/`JobOffer` machinery) lands, it reads the same shelf —
the contract frame is preserved, not forked.
**Port laws** (`ImportBytesStagePort`, `import-export.port.ts`):

- **Single slot, last write wins** — the panel serializes previews deliberately;
  residue pressure is O(1) by construction.
- **Claim-on-read** — a consumed slot never answers twice; TTL-dead or mismatched
  bytes are consumed, not inherited by a later request.
- **Name/size lie detector** — staged bytes that don't match the wire-declared
  `fileMeta` answer `undefined`; the adapter then refuses honestly
  (`E_FORMAT_UNKNOWN 'import-bytes'`). Declared-size and decoded-size guards from
  WP5 stay the final law.
- **TTL 15 min** (`IMPORT_STAGE_TTL_MS`) — staged bytes are C25 consumables, never
  archives; crash residue sweeps on read and via `sweep()`.

**Implementation honesty.** Raw IndexedDB, zero imports: the importers family must
never touch journal/storage infrastructure (depcruise law), and both the SW root
**and** the page root compose the same module without dragging an engine in. The
shelf is always an optional seam: absent factory (test hosts, degraded runtimes) ⇒
unwired, and previews answer the WP5 `import-bytes` refusal rather than crashing
boot. Faults propagate typed (`E_CORRUPT_STORE`, `E_QUOTA`) — the hinge never
invents bytes.

## 4. Surface narrowing (A-05 caught at ship time)

The panel's first draft imported `ImportBytesStagePort` directly and depcruise fired
`surfaces-are-authority-free` (surfaces see only `application/(contracts|hub)` and
`surfaces/components`). **Fix:** `ImportStageWriter` — a single-verb structural
narrowing in `surfaces/components/session/import-stage.ts`; the page root composes
the full port, the surface holds only `put`. The surface can never ask the shelf
questions (`takeMatching`/`sweep` are SW-side concerns). Recorded as the pattern for
any future surface-facing port verb.

## 5. Panel behavior laws (quiet page, `import-export` section)

- **One preview flow at a time** (UI law). `pendingPreview` closure state keeps the
  lane across nav switches; an abandoned preview is TTL-swept SW-side honestly.
- **Real file input**, staged on change (`accept=".txt,.json,.html,.htm"`), then the
  frozen `ImportPreviewRequest {fileMeta}` rides the wire untouched.
- **Census lane** from `modelSummary`: detected structure line, dupes/rejects extras
  line, rejects note when r>0; a malformed/foreign summary degrades to the bare
  ready hint (never a broken card).
- **Dedupe default is `skip`** (conservative; `import-anyway` is an explicit radio).
- **Commit receipt**: outcome lands as a persistent receipt line in the block
  (`{imported} tabs imported; {dupes} were already here.`) while announcements ride
  the live region (announcer text replaces; the receipt persists) — an a11y-law
  detail discovered in test (double `say` collapses to the second message).
- **Corrupt-abort copy** maps typed codes to W15-honest prose: unknown format names
  the supported formats (`msg.import.unsupported`), guard/majority faults get calm
  specific copy, quota/store faults reuse the existing catalog recovery rows.
  Panel-local error card with retry-to-picker, never the section-wide error swap
  for flow failures (context preservation).

## 6. Preview <2s (roadmap DoD)

The parse cost is the E5-T05 pipeline's: `import.parse` perf rows (house budget
5s @10k-class, observation tier) measured hundreds of ms per 10k-line file in the
smoke lane; typical OneTab/SessionBuddy files are far smaller. The panel adds one
IDB write + one IDB read (single-slot, <10ms class). The <2s typical figure is
therefore parse-dominated and already evidence-backed by the perf scenario; any
UI-side regression would surface in the pending strip (client pending law).

## 7. Follow-ups

- **[follow-up] Rejects file surface**: the SW-side `fetchRejects(previewId)` seam
  (WP5) has no wire row yet — designing that row is the same amendment class as
  this note's §2 and pairs naturally with ExportReady's fetch machinery (E5-T07).
  v1 shows the honest count; the downloadable list (W15) is owed.
- **[follow-up] Stage lifecycle on SW restart**: a staged-but-never-previewed file
  dies by TTL (15 min) — no boot-time sweep exists (the shelf is claim/sweep driven).
  If telemetry ever shows shelf litter, a boot sweep is a one-line root addition.
- **[follow-up] Offscreen migration**: when §3.6 workroom lands, the bytes shelf is
  the migration seam — the parsers move offscreen, the shelf contract stays.

## 8. Evidence index

| Law                                                                                     | Executable gate                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Amended ImportReady emission                                                            | `ops/tests/unit/application/outbox.test.ts`                                  |
| Service hinge (resolve/refuse/fault)                                                    | `ops/tests/unit/application/system-prefs-portability.test.ts` (E5-T06 block) |
| Shelf port laws (7 tests)                                                               | `src/infrastructure/importers/bytes-stage.test.ts`                           |
| Panel flows (stage→preview, census lane, dedupe choice, cancel, receipt, corrupt-abort) | `ops/tests/unit/surfaces/quiet.test.ts` ("E4 quiet · import & export")       |
| Surface narrowing                                                                       | `.dependency-cruiser.cjs` `surfaces-are-authority-free` (enforced)           |
| Parse-side timing                                                                       | `ops/perf/scenarios/import.ts` `import.parse.*` rows                         |
