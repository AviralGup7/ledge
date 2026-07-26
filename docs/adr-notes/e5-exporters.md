# ADR note — E5-T03 Exporters (json/html/md) decision record

**Status:** decisions taken while building the E5-T03 export render pipeline
(`infrastructure/exporters`: canonical model, render-json/html/md, verifying
assembler, ExporterPort adapter, root wiring, `export.render` perf row). No ADR
reversals; every item composes within ADR-038 (public contract = export format —
no programmatic API), ADR-040 (size/time guards), ADR-045 (canonical model =
projection snapshot; chunk-verify-then-present; format versioned read-forever),
EES §2.14 (never silent-partial; full provenance), EES §6 ExportRendererPort row.
**Authored:** 2026-07-26, E5-WP2 close-out.

Each entry: the question, the decision, the why. **[follow-up]** names the
milestone that owns the remaining work.

---

## 1. Pipeline shape

### 1.1 SW-composed v1 with the offscreen protocol as the 100k door (WP1 pattern, extended)

ADR-045 says "Streaming generation in offscreen (100k-tab archives must not
exhaust memory)". v1 composes the whole pipeline in the SW (`bg-root`), because:

- the render path is storage-INDEPENDENT and compute-bounded — measured at
  9 ms @100 tabs and 68 ms @1 000 tabs for the seal format (`export.render`
  perf row), i.e. ~3 decades of headroom against the §6 60 s @100k budget
  before the offscreen boundary pays for itself;
- the chunk stream (`RenderChunk {seq, partId, text, checksum}`) is exactly the
  frame shape an offscreen document transport would carry — the boundary is
  designed-in, not retrofitted.

**Decision:** renderers are PURE sync part-builders (`jsonParts/htmlParts/mdParts
→ readonly RawPart[]`); `streamParts` is the async façade (the only place that
later becomes a document transport). **[follow-up]** the milestone that opens the
50k/100k export tier swaps `streamParts`' consumer, not a single renderer line
(E-milestone, same class of door as E5-T01 §3.6).

### 1.2 Whole-render regen ×2, not per-chunk regen (v1 honest reading)

EES §6: "E_RENDER_CHUNK(checksum) → regen ×2 → E_RENDER_FATAL". In-process, a
chunk that fails re-verification can only be source-corruption (a renderer bug)
or test-injected transport corruption — per-chunk regen would re-run the same
deterministic function and re-fail identically.

**Decision:** `assembleVerified` re-runs the WHOLE render up to `REGEN_ATTEMPTS`
(2) extra attempts; persistent mismatch ⇒ `E_RENDER_FATAL{fault:
'chunk-checksum-regen-exhausted', partId, seq}`; a renderer that disagrees with
itself across regens is fatal (never a partial). Per-chunk regen remains the
offscreen transport's semantics when the boundary is crossed. **Regression-pinned:**
`stream.test.ts` (transient ⇒ transparent success; persistent ⇒ fatal with
details; regen-budget arithmetic boundary).

### 1.3 Part grammar: separators ride INSIDE the part that precedes them

The json document is emitted as ordered parts (`head`, `mission:<id>`,
`loose:<i>`, `tail`, `manifest`) whose byte-concatenation IS the artifact — so
part checksums are reorder-robust and verification never re-parses JSON grammar.
The array commas belong to the preceding part; empty arrays stay valid; the
`manifest` part (the sealer) is excluded from its own parts list (self-reference
law: the manifest seals DATA parts only — assembler and embedded manifest agree
by construction, and the test proves byte-equality of both).

**Why:** a part-id-addressed checksum grammar is what makes "no silent partial"
checkable at all — a monolith blob would verify only globally (all-or-nothing
with no fault coordinates). **Regression-pinned:** `renderers.test.ts` (grammar
validity by `JSON.parse`, embedded≡sealed manifest, LOOSE_BATCH part-id
arithmetic, empty-model edge).

### 1.4 `manifestChecksum` = crc32 over `partId:checksum` lines; the plan seal rides json

Per-part checksums use the kernel's crc32 (`crc32Hex` — the function the journal
already trusts; its header names exporter chunk-verify as a design consumer).
The manifest seal is crc32 over the ordered `partId:checksum` line list. The
`ExportPlan.manifestChecksum` is the **json** artifact's seal (ADR-045's fidelity
format = canonical seal); without json requested, the first canonically-ordered
rendered format seals (`formats` are served in fixed `json,html,md` order
regardless of request order — determinism of the audit stamp).

## 2. Truth + honesty laws

### 2.1 The canonical model is a read-model snapshot WITH drop arithmetic

`buildModel` reads missions+tabs view rows (via an injected `ExportModelSource` —
depcruise `importers-exporters-via-application-only` holds: storage types enter
only as application ports in `model-source.ts`). Mission membership resolves via
`mission.tabIds` in declaration order; a ref without a tabs row is **dropped AND
counted** in `diagnostics.droppedTabRefs` (never fabricated); tabs without a
resolvable non-trash mission export as `looseTabs`; trashed truth never crosses
the front door (excluded, not counted — the recovery net is not the export's
business). Deterministic ordering: missions by `createdAt`(then id), loose tabs
by `firstSeenAt`(then id) — same truth ⇒ same bytes ⇒ same checksums (the
rebuildable-artifact law, perf-asserted at the min memory tier).

### 2.2 Provenance stamps are export-time truth, never row-derived

`format/formatV` constants (`ledge-export`/1), `app.build` = the running build's
**contract hash** (`computeContractHash()` — package.json carries no meaningful
version in this repo, so the registry hash is the honest build identity),
`canonRulesV` = the in-force rules object version (`CANON_RULES_V1.version`),
`generatedAt` from the injected clock. §2.14's full-provenance invariant holds
with zero trust in row contents. **[follow-up]** E5-T04 (export-format-v1.md)
freezes these fields as the public covenant; the examples in that doc must
validate against these renderers (roadmap AC "examples validated").

### 2.3 Fixture-lulz are estate law: ids are ULID-minted in tests

The adapter takes `IdGenerator`; production composes `platformIds`, tests use
`platformIds` directly (no fixed ULIDs — `testId` would ride a journal-testkit
import that the `importers-exporters-via-application-only` depcruise rule bans
for this family even in test files). No exceptions were carved: the rule passes
unmodified (228 modules/0 violations).

## 3. Delivery seams (what this WP ships vs defers)

### 3.1 The artifact registry is bounded (TTL + cap; sweep AFTER insert)

Rendered artifacts live in an in-SW registry keyed by `exportId`
(`EXPORT_ARTIFACT_TTL_MS` 10 min, `EXPORT_ARTIFACT_CAP` 4, evict
expired-then-oldest). The sweep runs AFTER insertion — a sweep-before-insert
lets the fresh entry push past the cap by one (found by the adapter test, not
by review; the arithmetic is pinned). `fetchArtifact` self-checks expiry (the
fetch machinery's future call path, diagnostics today).

### 3.2 ExportReady stays silent in v1 — the fetch machinery is the door

The wire's `ExportReady{fetchURL, manifestId, chunkChecksums}` emission law
(outbox) fires only when a command result carries those fields; the frozen
`ExportRequest` response is `{exportId}` and this WP changes NO registry rows
(append-only law A-09: additive response fields would still be an edit-class
change requiring its own ADR — not smuggled into a render milestone).
`ExportPlan.fetchRef` = `{exportId}` (opaque per the port contract), which is
exactly the registry key the fetch stream will serve.

**[follow-up]** the "workroom streaming contract" (EES §3.1(d): payloads >256KB
ride streaming) + a download surface: negotiate either an on-demand chunk drain
by manifestId or a Blob hand-off in an extension page. Candidates: E5-T06-era
quiet-page work or the deferred browser-adapter/workroom milestone. Until then,
`exportRequest` truthfully answers "rendered + sealed + audit-journaled" — and
the bytes are one registry read away from any future fetch seam.

### 3.3 budgets.json intentionally UNTOUCHED

The `"importers exporters"` budget globs `(import|export)` against OUTPUT
FILENAMES (entry chunks), and SW-composed exporters ride the `background`
budget (71.1 KB gzip / 300 KB with search+exporters composed — headroom intact).
A required-entry flip now would either match nothing (law violation) or
redundantly re-budget the background chunk. The entry flips with the milestone
that ships an offscreen import/export document chunk (§1.1 door) or the WP5
importers' own chunk.

## 4. Perf row (`export.render`)

Family design: model fabricated in-memory (the render path is
store-independent — a dexie-labeled row would claim IDB involvement that does
not exist, so non-memory sessions return `[]`; projection-snapshot read cost is
the storage/projections families' row). The row carries `budget: 60_000` (EES
§6/§12 bench, observation-until-E8-T15 like every §7.1-derived row; budget rows
are intentionally never baselined — "compare against law, not history").
Determinism evidence (min memory tier): same-model renders must seal
identically — a divergence throws inside the scenario. `REQUIRED_ROWS` gained
`export.render`.

### 4.1 **Finding (routes to E8-T15, sequel to e5-search.md §5.3):** sandbox ambient-memory trips the dexie boot regression law

Measured 2026-07-26 on this sandbox at WP2-close code: `dexie/lifecycle.
memory.boot.peak|steady/1000` = 234 MB vs baseline 114 MB (>1.5× + 32 MB
floor) — ambient heap of a loaded virtualized runner, exactly the class the
E7-T02 note sized its floors for ("~ +41 MB ambient RSS shift" measured
there; this box showed +120 MB). Same run: budgets green (wake included),
zero scaling findings, `search.query`/`export.render` rows present and far
under budget. Not addressed here (harness re-timing is E8-T15's remit; the
perf gate is nightly-only, not PR-gating).

---

**Cross-references:** ADR-038/040/044/045 · EES §2.14/§3.1(d)/§6
ExportRendererPort row/§12 exporters · roadmap EPIC E5 (E5-T03 → T04 spec doc
→ T05 round-trip) · `docs/adr-notes/e5-search.md` (WP1, same epic).
