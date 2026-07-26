# ADR note — E5-T05 Importers (three parsers + two-phase ImporterPort adapter)

Status: shipped (E5 milestone, roadmap-pure scope). Companion notes:
`e5-export-format.md` (WP3 covenant), `e7-fixture-corpus.md` (WP4 acceptance set),
`e5-exporters.md` (WP2 sibling family patterns). Frozen contracts this WP honors:
`ImporterPort` (C20/C21), `ImportPreviewed` (TTL 1h) / `ImportCommitted`
(idempotent by batchId), EES §2.14 ImporterPort row, ADR-044 (two-phase law),
ADR-040 (parse purity), ADR-016 (canon matching only).

## 1. Scope: three parsers, roadmap-pure

**Question.** Does E5-T05 include the first-party `parser-ledge-export`
reader (ADR-044's fourth parser), as WP3's covenant §9 implied?
**Decision.** No. Roadmap row 78 pins E5-T05 to OneTab, SessionBuddy, Netscape +
two-phase commit (EES-R11). The first-party v1 reader is a **recorded v1.x gap —
[follow-up]**; the covenant cross-ref is corrected in the same commit as this note
(small honest edit, not a redesign).
**Why.** The user ruled E5 scope roadmap-pure; honest labeling beats silent scope
creep in either direction. The covenant's §9 promise ("every Ledge release reads
format v1") stands un-weakened — the reader is owed, versioned, and tracked.

## 2. Transport: v1 bytes union, workroom streaming is the door

**Question.** How do file bytes reach the SW parser when the frozen C20
`bytesRef: unknown` is deliberately opaque?
**Decision.** v1 transport union: `string | {kind:'text',text} | {kind:'bytes',
bytes:Uint8Array}`; anything else refuses `E_FORMAT_UNKNOWN` with `what:
'import-bytes'`. The workroom streaming contract (E3-T07 skeleton) is the eventual
frame transport — **design question parked for E5-T06 [follow-up]**: the quiet-page
panel must stream `<input type=file>` bytes into the SW without a 32MB structured
clone spike.
**Why.** The union is honest about what v1 can do (SW composition, no DOM, no
FileReader access from the service worker); the door is explicit where C20's
comment reserved it. Refusing unknown transports loudly mirrors the exporters'
fetchArtifact seam honesty.

## 3. Detection: content-primary, head-sniff, hostile-first-line tolerant

**Question.** How does `detect(fileMeta)→parserId` behave when the extension lies
and the opening line is hostile?
**Decision.** Sniff the first 512 chars (O(1) — files reach 32MB). Anchors: JSON
array `^\s*\[` → sessionbuddy; `NETSCAPE-Bookmark-file-1` doctype or `<DT><A` tag
→ netscape; **any head line starting with http(s) (multi-line anchor)** → onetab.
`parserHint` overrides when valid; an invalid hint is `E_FORMAT_UNKNOWN` with
`what: 'parser-hint'` and the hint echoed. A sessionbuddy structurally broken JSON
array maps to `E_FORMAT_UNKNOWN` `what: 'import-json'` — the file ISN'T the format,
which is different from a good file with bad rows.
**Why.** Content decides, never the extension (a `.json` name can lie). The
multi-line onetab anchor was forced by the corpus: `hostile-schemes-malformed.txt`
opens with a `javascript:` quarantine line — anchoring on line one alone refused a
legal OneTab file. JSON rows stay safe: their URLs are quote-anchored mid-line,
never at line start (verified against the sessionbuddy hostile corpus).

## 4. Reject quarantine: per-record verdicts, majority-fatal threshold

**Question.** When do bad rows refuse the file vs ride the rejects census?
**Decision.** Per-record taxonomy: `scheme-quarantine` (non-http(s) scheme),
`url-malformed` (no scheme shape at all / unparseable), grammar-level rows
(orphan titles, tight pipes, wrong-typed JSON fields, missing URLs — additive
unknown fields tolerated). The file is refused with `E_PARSE_REJECTS` only when
`records ≥ 16 AND rejects > records/2`.
**Why.** EES-R11: batch undo legal only on complete; a mostly-quarantine file is
almost certainly mis-detected content, not a library. The majority law keeps the
corpus's 15-reject hostile basics importable with their full census while a
19-record file with 16 scheme lines is refused whole. Zero-record previews are
honest zeros, not parse failures (empty `[]` SessionBuddy array previews as
`sessionbuddy:m0:t0:r0:d0`).

## 5. File guards: size caps, wall-clock deadline, no silent truncation

**Question.** What stops a hostile or pathological file from stalling the SW?
**Decision.** `IMPORT_MAX_BYTES = 33_554_432` (32MiB) — checked twice: declared
`fileMeta.size` **and** the decoded payload (a lying fileMeta gets the same
refusal). `PARSE_DEADLINE_MS = 30_000` wall-clock with a probe every 2,000 records;
a breach is `E_FILE_GUARD` with `what: 'parse-time'`.
**Why.** Load-shedding precedes elegance at the boundary: the E7-T01 generator's
`sessionbuddy:200000` file is 107MB and is _refused, loudly_ — that refusal is the
M4 "caps proven" evidence. The EES §6 ImporterPort row is memory law
("100k-line bookmark file streamed; memory ≤40MB"), not a latency budget —
memory-lane evidence for the parse path is **[follow-up]** to E8-T15 hardening.

## 6. Preview stash: TTL 1h, cap 2, sweep after insert

**Question.** Where does the parse live between preview and commit, and what is
the freshness law?
**Decision.** In-memory stash in the adapter (SW-bound, like WP2's exporters):
`PREVIEW_TTL_MS = 3_600_000` (EES §5 ImportPreviewed TTL 1h; C21 "previewId fresh
(<1h)"), `PREVIEW_STASH_CAP = 2`, sweep runs **after** insert (WP2 lesson: memory
law holds at every instant, evicting TTL-dead then oldest). Commit against an
unknown id is `E_DOMAIN_LEGALITY` `preview-unknown`; against a TTL-dead one is
`preview-stale` and the entry is dropped on the spot.
**Why.** The stash is the two-phase hinge (ADR-044): preview parses eagerly so the
panel shows real counts; commit reuses the parse. The SW never piles previews;
repeated preview→commit cycles in one SW session stay cap-bounded by construction.

## 7. Idempotency: batchId := previewId

**Question.** How is C21's "idempotent by batchId" realized?
**Decision.** `batchId := previewId` — identity-derived at commit time. A replayed
commit replays the same journal idempotency key material; both appends carry the
identical batchId.
**Why.** C21 demands dedupe material that survives invocation boundaries; deriving
from the preview id makes the key stable by construction. Durable mission/tab ids
stay application truth and re-mint per invocation (`opKey` law: the journal never
sees key-reuse-with-alien-content). **Service-side dedupe-by-batchId is the
recorded door — [follow-up]**: two live invocations today journal two
ImportCommitted appends with distinct minted ids (unit lane pins the honesty);
projection-side comment already states replay law for identical manifests.

## 8. Canon stamping + dedupe: intra-file only, archive-blind by law

**Question.** Where do `urlCanon`/`domain` come from, and what does dedupe mean?
**Decision.** Stamped once at preview: `canonicalize(url)` per surviving tab,
`canonRulesV: CANON_RULES_V1.version` echoed into the plan (mirrors the WP2
exporters). Dupes are **intra-file canon-equal tabs** (first occurrence survives;
`utm_*`-drifted copies collapse on the canon form). `dedupeMode:'skip'` filters
dupes from the plan (zero-tab missions are then dropped — plan shape never carries
empty missions); `'import-anyway'` keeps them. Reported `dupes` equals the preview
`dupesHint` regardless of mode: what the file contained and what was imported are
different questions.
**Why.** ADR-016: canon is matching material, never a rewrite. Dedupe-against-the-
existing-archive is deliberately NOT here: ports are archive-blind
(`importers-exporters-via-application-only` depcruise law) — that comparison is an
application-layer question and E5-T06's surface decision — **[follow-up]**.

## 9. Grammar-to-mission mapping (corpus-pinned)

**Decision.** OneTab groups (blank-line separated) → missions named `''` (the file
carries no names). Netscape `<DT><H3>` folders → missions; nested folders are flat
sibling missions (no tree shape in `ImportedMissionPlan`); root-scope links → the
`''` loose mission; `<DD>` descriptions belong to the previous entry (never a
tab, never a folder); unclosed tags close at the next tag / EOF; entities decode
in reverse-5 order (`&amp;` last). SessionBuddy windows → missions; session,
window, and row levels quarantine independently; additive fields are tolerated,
missing URLs are row-level rejects, non-array JSON is `import-json` (§3).
**Why.** Every mapping is a corpus-verified verdict (17 committed files, 21 census
assertions), not a grammar guess. Read-side dropped: netscape `ADD_DATE` (the plan
shape has no timestamp home yet) — **[follow-up]** if provenance lands.

## 10. modelSummary is a shape key

**Decision.** `'<parserId>:m<n>:t<n>:r<n>:d<n>'` — missions/tabs/rejects/dupes
census, e.g. `onetab:m1:t3:r1:d1`.
**Why.** §4 of the events registry: ImportPreviewed's modelSummary is structural
summary material (audit + workroom), never display copy; numbers belong to the
UI's own model assembly in E5-T06.

## 11. fetchRejects seam: the roadmap "rejects file" rides a port

**Decision.** The adapter exposes `fetchRejects(previewId)` returning the
quarantined `RejectRow[]` (`{ref, reason, excerpt}` — excerpt bounded at 80 chars).
**Why.** Roadmap row 78 demands the rejects file; the UI surface is E5-T06's. The
seam mirrors the WP2 exporters' `fetchArtifact` pattern: infrastructure owns the
material, the surface owns the presentation; no law leaks either way.

## 12. Perf evidence: import.parse rows, house budget, honest session

**Decision.** `ops/perf/scenarios/import.ts` emits `import.parse.<format>` rows
(memory session, 10k generator class — A3 reuse of the WP4 seeded corpus: WHAT is
parsed matches the parser unit/contract lanes byte-for-byte). `BUDGETS.
importParseMs = 5_000` is **house-declared**: EES §6 has no ImporterPort latency
row (its memory row is §5-material for E8-T15) and E5-T06 owns the preview <2s
surface law. Determinism evidence per format: same-bytes re-preview across fresh
adapters must produce an identical modelSummary (pure-parser law). Budget JSON
untouched: the importers are SW-composed and ride the background.js bundle budget
per WP2 rationale §3.3; the `required:false` importers/exporters entry flips only
when a real import/export entry chunk ships.
**Why.** Storage-independence honesty (mirrors export.render): a dexie-labeled row
would claim IDB involvement that does not exist; the commit side's store cost is
the storage/projections families' row, not this one's.

## 13. Bites caught at ship time (parser lane)

Three failure classes the corpus exposed _after_ the pure-parser lane was green —
the 17/17 parsers lane is necessary, never sufficient:

1. **Fused-token anchoring.** First netscape implementation anchored on oneTab-style
   fused `<DT><A` tokens; the tokenizer yields one token per tag, so anchors moved
   per-tag with an explicit HREF_ATTR guard.
2. **Quote-blind tag cutting.** `<[^>]*>` truncates a tag whose HREF payload
   contains `>` (`data:text/html,<h1>…`); the record vanished _silently_ (6 counted
   instead of 7). Tokenizer is now quote-aware by construction.
3. **Line-one detection.** §3's multi-line anchor fix — the parsers were right and
   detection was wrong. Test-first ordering matters most exactly at seams.

The rejects report and the census assertions both derive from file bytes + shipped
adapter — nothing is hand-transcribed, so a future parser change that flips a
verdict fails loud instead of drifting.
