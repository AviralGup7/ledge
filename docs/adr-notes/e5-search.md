# ADR note — E5 Search & Portability decision record (WP1: E5-T01 search index + ranker)

**Status:** accumulation of route-level decisions taken while building E5-T01 (the
ADR-015 inverted index as a journal projection, the BM25-ish ranker behind
`SearchRankPort`, the application query integration, and the `search.query` perf
row). No ADR reversals; every item composes within ADR-005 (single-writer — search
appends nothing), ADR-010 (frozen wire window — engine-internal views never publish),
ADR-015 (projection-built index, tokenizer stamped, tunable constants), ADR-029
(maintenance-lane rebuild), EES §2.11 (index is a deletable/rebuildable projection;
correctness > freshness). **Authored:** 2026-07-26, E5-WP1 close-out.

This note exists so no decision below lives only in a commit message or an inline
comment. Each entry: the question, the decision, the why. Items marked
**[follow-up]** name the milestone that owns the remaining work.

---

## 1. Index construction

### 1.1 The index builds SW-chunked as a projection-engine projector — the offscreen build stays the 50k door

ADR-015's MV3 row reads "Index build in offscreen, throttled (ADR-029)". The
WP1 corpus (v1 target: thousands of tabs, not 50k) does not need offscreen build
economics, and the projection engine ALREADY owns resumable chunked replay,
per-view watermarks, dirty marking, and rebuild — the exact machinery an index
builder would duplicate.

**Decision:** `searchIndexProjector` is a first-class `ProjectorDef` (view
`'searchIndex'`, store `search_index`, keyField `'token'`) registered in
`V1_PROJECTORS`; index build/maintenance is `projections.applyFromJournal` +
`ensureIndexFresh() → projections.rebuild('searchIndex')` in SW chunks (ADR-029
maintenance lane). The EES §3.6 `IndexBuildRequest` offscreen protocol is NOT
deleted — it remains the documented door for the 50k-tab tier. This is a
**deviation-with-door**, not an ADR-015 reversal: the core ADR-015 law ("the index
is built as a journal projection, never as an independent side ledger") is obeyed
verbatim. **[follow-up]** E-milestone that opens the 50k tier re-visits the
offscreen buildpath under §3.6; the projector needs no change to feed it.

### 1.2 Three row families in one store — term postings, doc registry, stats

The `search_index` store (schema.v1, pk `'token'`) holds exactly three row
families, namespaced by key: TERM rows (`{token, p: PostingEntry[]}` — the
inverted lists), REGISTRY rows (`{token:'tab:<id>', title, url, domain, terms, dl,
st, la, canonHash}` — the per-doc re-tokenization input AND the `dupesFor`
surface), and one STATS row (`{token:'meta:stats', docs, totalLen, tokenizerV}` —
BM25 corpus statistics plus the stamped tokenizer version).

**Why:** posting-only designs cannot re-tokenize a changed doc without re-reading
journal truth; the registry row makes every update a read-model-local
re-tokenization (zero-op law included: same terms ⇒ no ops). Stats rides the same
store so a rebuild wipes and re-derives ALL index truth in one pass — no orphan
counters. **Regression-pinned:** `index.projector.test.ts` (family discipline,
zero-op, drain-to-remove, stats balance).

### 1.3 The registry SURVIVES trash; purge removes it

`EntityTrashed` drops postings (trashed docs are unsearchable) but keeps the
registry row stamped `st:'trash'`; `TrashRestored` re-materializes postings as
`kept` FROM the registry row; `TrashPurged` removes the registry row itself.

**Why:** restore-after-trash must not require a journal re-read (projection-local
law), and purge is the only legal point where a tab's search truth disappears
(retention law). Stats count only the SEARCHABLE population (live+kept), never
the trashed residue. **Regression-pinned:** lifecycle mirror tests.

### 1.4 KEPT producer law: `TabAssigned` only

Only `TabAssigned` flips a doc `live → kept`; `MissionFormed` (whose tabIds are
assignment-shaped but semantically "formed from these live tabs") is a no-op;
`MissionResumed(restoredMapping.tabs)` flips kept docs back to `live`;
`TabClosedExternal` kills only LIVE docs (a KEPT doc is stickier than a close —
the mission archive keeps it findable); `ImportCommitted` indexes manifest tabs
as `kept` in one fan-out.

**Why:** mirrored exactly from the tabs read-model's state machine — the index is
a projection OF truth, never a second opinion about it; a divergent lifecycle
mirror would rank dead tabs. **Regression-pinned:** each arm has a test.

## 2. Tokenizer + ranking

### 2.1 `TOKENIZER_V` is stamped on the built index; drift ⇒ unavailable ⇒ self-heal

The STATS row stamps `tokenizerV`. The adapter answers
`{kind:'unavailable', reason:'tokenizer-mismatch'}` when the stamp differs from
the shipped constant (an old-tokenizer index must never silently answer with
wrong segmentation), and `ensureIndexFresh()` rebuilds on `dirty || mismatch`
(ADR-029 maintenance lane, driven once at bg-root compose).

**Why:** EES §2.11 correctness-over-freshness. A tokenizer change is a
`TOKENIZER_V` bump; the background full reindex law rides exactly this seam.
**Regression-pinned:** adapter tokenizer-mismatch self-heal test.

### 2.2 Tokenizer v1: unicode word runs (≥2 chars), CJK overlapping bigrams, URL scheme-stripped

Latin/digit runs of unicode letters+numbers, lowercased, minimum length 2
(single-char runs are a noise floor that floods posting rows); CJK runs segment
into every overlapping bigram with an isolated char degrading to a unigram (the
ADR-015 "bigram fallback" law); URLs are tokenized scheme-stripped (host+path
segments), so `https://docs.example.com/a-b` ⇒ `docs example com a b`.
`tokenizeFields` fuses title ∪ domain ∪ url ∪ topics, deduped in
first-occurrence order (determinism is a law input). Hand-rolled — no runtime
deps, byte-identical across Node/SW. **Regression-pinned:** tokenizer goldens
(latin, CJK, URL, fusion, TOKENIZER_V stamp).

### 2.3 BM25-ish + boosts; constants tunable without schema change

idf is the Robertson/Sparck-Jones +1 form (non-negative over the full df range);
term score saturates with `k1=1.2` and length-normalizes with `b=0.75` against a
corpus avgdl that degrades safely at 0 (empty-corpus totality — scoring never
throws). Postings carry `tf, dl, st, la` so per-term contribution composes
index-side. Ranking multiplies BM25 by two bounded boosts ≥1: recency
(`1 + 0.25·exp(−age/14d)`) and open-state (`1 + 0.35` live). All constants live
in one `RANK` table — ADR-015's "tunable without schema change" row.
**Regression-pinned:** `ranker.test.ts` (idf sign law, saturation, length-norm,
boost composition, degenerate-corpus totality).

### 2.4 AND totality; scope is index-side for open/kept

Query answering intersects postings across ALL query terms (no term may miss);
sort is score-desc, tie id-asc (deterministic). Scope `open`/`kept` rides the
posting `st` tag; scope `closed` is index-empty by design (the index mirrors
open+kept only) — closed recall rides the application sweep tail (§3.2).

## 3. Application integration

### 3.1 Availability is a VALUE, never a throw

`SearchRankReply = ok{hits,freshness} | unavailable{absent|dirty|tokenizer-mismatch}`.
The query service treats any non-ok answer as "fall back to the keyword read-model
sweep with `freshness:'fallback'`" — EES §2.11's absent/corrupt law and EES §6's
none-throwing port row in one shape. **Regression-pinned:** adapter unbuilt-index
test + queries fallback tests.

### 3.2 Ranked head ∪ bounded sweep tail — recall-parity law

The port is term-based (AND); the pre-existing sweep is substring-honest. Serving
ONLY ranked hits would REGRESS recall for substring-isms that never tokenize
(" roadmap" mid-word fragments, scheme fragments, punctuation runs).

**Decision:** `search()` composes ranked hits (materialized from the tabs store in
one txn, missing rows DROPPED never fabricated) with the bounded sweep tail,
`seen`-deduped, ranked order preserved — the union is served, freshness is
`min(port, sweep)` honesty (`'lagging'` when the port flags lag past
`SEARCH_LAG_THRESHOLD`, `'fresh'` otherwise, `'fallback'` on the sweep-only path).
Closed scope rides the sweep tail entirely (§2.4). **This is the v1
recall-parity law:** a stricter-or-equal recall than the pre-E5 behavior, with
ranking quality added on top. **[follow-up]** E5-T02 (v1.1) may revisit with
semantic hashing behind the same port.

### 3.3 Freshness lag is an arithmetic disclosure, not a guess

`freshness().lag = Σ_devices max(0, head.lastSeq − viewWatermark.seq)` — read from
the journal heads meta row (`META_JOURNAL_HEADS_KEY` — the projections engine's
own head source) minus the searchIndex watermark from `projections.status()`.
Past `SEARCH_LAG_THRESHOLD` (2_000, EES §2.11's number) the query service downgrades
`mergedFreshness` to `'lagging'` and the DTO surfaces it. The correctness law is
served by the sweep tail always riding along (§3.2), so lagging never lies about
recall. **Regression-pinned:** adapter lag-threshold test + queries lagging test.

### 3.4 `dupesFor(canonHash)` is a bounded registry scan (v1)

EES §6's `dupesFor` row ships as a bounded scan over REGISTRY rows matching
`canonHash` (the hash is an index key, never an equality oracle — canon law). The
dedicated `dupe_index` store stays the E5-T02 (v1.1) seam. **Regression-pinned:**
twins/singleton/unknown-hash test.

## 4. Wire + dependency governance

### 4.1 Engine-internal views NEVER ride the ADR-010 wire window

`'searchIndex'` is a `ViewName` (the port documents it is NOT in the ADR-010
window), so its engine delta frames flow into `onDelta` like any view. Without a
guard, the outbox would publish `ViewDelta{view:'searchIndex'}` and watermarks
for a view surfaces have no pk catalog for — and a rebuild's regression would emit
`ResyncRequired` poison.

**Decision:** the outbox `publishDelta` guards on a `WIRE_VIEWS` set (the four
surface-consumed views); internal frames return before any watermark bookkeeping.
**Regression-pinned:** outbox wire-guard test (mute normal + mute regression +
windowed twin still publishes).

### 4.2 writer-concentration family gains `search` (ADR-005b precedent)

`search.adapter.ts` imports one constant from `infrastructure/journal`
(`META_JOURNAL_HEADS_KEY`) — the heads-row key is journal-truth and duplicating
the string locally would be a silent schema-drift hazard, the worse sin. The
depcruise rule's durable-write family list was amended (`snapshots` precedent,
ADR-005b-T08) with this note referenced in the rule comment. Search appends
NOTHING; all writes flow through the projection engine. Importers/exporters stay
expressly forbidden from this family (`importers-exporters-via-application-only`
unchanged — WP2/WP5 compose via application ports).

## 5. Perf row (`search.query`)

### 5.1 The §6/M3 budget ships as a law-gated observation, never a baseline row

EES §6 / roadmap M3: query p95 ≤ 100 ms @10k corpus. The scenario
(`ops/perf/scenarios/search.ts`) seeds a deterministic TabObserved corpus
(contract-complete payloads; strict append validation is the law), builds the
index per backend×scale, and times a fixed probe set (common-term, AND, rare,
medium) so the p95 surface is honest. The row carries `budget: 100` — and
`saveBaseline` skips budget rows BY DESIGN ("budget rows compare against law,
not history"), so **no baseline surgery was performed or needed**; regression-
compare N/A is architecture, not an omission. Hard-breach wiring stays with
E8-T15 like every other §7.1-derived row (observation until hardened).

### 5.2 Rebuild-determinism evidence rides the smallest memory tier only

The in-scenario throw-on-divergence check (probe answers identical across
`rebuild('searchIndex')`) costs a full corpus replay through the index fan-out.
It is gated to the smallest memory tier because the same law is already
engine-wide-proven for this projector in the unit lane (adapter rebuild-envelope
test) and the property lane (replay-purge law drives the `search_index` shelf) —
dexie-tier rebuild evidence would double family wall-clock for zero new
information.

### 5.3 **Finding (routes to E8-T15):** default-profile suite is wall-clock-marginal on loaded virtualized runners

Measured on this sandbox 2026-07-26: pre-E5 suite ≈ 47.8 s wall with a FLAKY
pre-existing hard-budget breach (`dexie/lifecycle.wake/1000: 210.6 ms vs 200 ms`
at literal origin/main `34cee47` — red once, green twice across identical-code
runs). The search family adds ≈ 5–6 s after trimming (m@100 0.05 s, m@1k ≈ 1.5 s,
d@1k ≈ 4 s, dominated by the journal-append + index fan-out, i.e. real algorithmic
cost), putting the sandbox total at 52–62 s — straddling the 60 s house law HERE.
The perf gate is nightly/release (not the PR gate) and runs on CI hardware; no
pre-existing family grids were re-tuned (E8-T15's remit, "Do NOT redesign"). This
is recorded, not silently absorbed.

---

**Cross-references:** ADR-005/010/015/029/038/044/045 · EES §2.11/§3.6/§6
SearchRankPort row · roadmap EPIC E5 (M3 "Find anything" exit).
