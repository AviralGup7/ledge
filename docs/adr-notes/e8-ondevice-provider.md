# E8-T03 · On-device provider (WASM in workroom + shadow eval) — decision record

Roadmap row: "E8-T03 OnDeviceML provider, naming | WASM in offscreen workroom +
shadow evaluation | E8-T02, E3-T07 | XL | provider in ladder + harness | shadow
eval proving OnDeviceML beats heuristic ≥ threshold". State: **shipped** —
rung-2 provider in the ladder behind capability detection, model bytes derived
and pinned by `check:ondevice-model`, and the completion criterion is the CI
gate `check:shadow-eval` (metric set frozen in `docs/ai-shadow-eval-v1.md`).

Numbering continues the E8 ledger: F1–F4 in `e8-ai-queue.md`, G1–G3 in
`e8-isolation-gates.md`. This note records **H1–H7**.

---

## H1 — the model is DERIVED bytes, never authored bytes

**Decision.** The runtime ships exactly two payloads — the hand-assembled WASM
match kernel (330 bytes, one exported `match_ptr` + `memory`) and the packed
`LFW1` weight table (25 frames × 127 terms, prior logits, display vocab) — and
both are emitted by `tools/ondevice-model/build-model.mjs` from
`tools/ondevice-model/lexicon.json`. `check:ondevice-model` re-emits in memory
and byte-compares (D1), re-verifies the committed sha256 stamps against the
payloads (D2), validates + instantiates the kernel (D3), enforces the memory
layout law (D4: needles at [4096, 16384), corpus at 16384+, 128 KiB),
rejects non-normal terms (D5), smoke-checks machine-vs-law over the real term
table (D6), and pins emission determinism (D7).

**Why.** ADR-040's `wasm-unsafe-eval` carve-out tolerates exactly one wasm
family; a carve-out is only defensible if the blob behind it is provably the
blob the repo describes. Byte-derivation makes hand-edits unrepresentable — a
tampered table fails D1 even with doctored stamps, and doctored payloads fail
D2/shadow-eval hashes. The alternative (commit raw binaries) was rejected:
unreadable diffs, unreviewable payload, unprovable provenance.

## H2 — the boundary law lives IN WASM; JS owns normalization

**Decision.** `normalizeText` (NFKD, strip combining marks, lowercase,
non-word runs collapse to single spaces) is JS; every candidate term verdict
is decided by the kernel — a naive boundary scan, flag-carrying discipline
(no `br` from inside `if`), word byte = `[0-9A-Za-z]` or ≥ `0x80`. The JS
`matchPhraseReference` exists only as the **law** the machine must equal:
unit M2 proves agreement per shipped bytes; shadow-eval G9 re-proves it at
corpus scale (~70k verdicts/run).

**Consequence (authored, enforced):** terms must be full-word (D5: a term
equals its own normalization). Raw stems (`" rust "`, `"profil"`) and
punctuation needles (`"next.js"`, `"b-tree"`) are dead by construction and now
rejected at authoring time — the lexicon ships `"rust"`, `"next js"`,
`"b tree"`, `"profile"/"profiling"` instead. Polysemy is an explicitly
out-of-scope v1 limitation (recorded in `docs/ai-shadow-eval-v1.md` §5).

## H3 — calibration ladder: pinned stamps, mission-grade duals

**Decision (constants, all exported + pinned in unit lane and in shadow-eval
G6).** Accept floor `σ ≥ 0.60`; dual margin `0.12`; sharp bar `σ ≥ 0.90`;
stamps `{0.88 sharp-dual, 0.85 sharp, 0.72 mid, 0.64 floor}`. Under R7's
frozen tiers that places dual names in HIGH (suggestion allowed), single hits
in MED, and the floor below accept — i.e., `0.64` is unreachable for emitted
names, kept as the vocabulary's honesty sentinel (calibrate never returns it;
G6 would flag any emission).

**Chaff register law (the refinement this task added).** Frames are
register-marked by logit: mission-grade ≥ `1.0`, chaff `0.3–0.4`
(email/calendar/chat/shopping/news). Chaff may _name_ only when it is the
entire story (its own z clears the floor — a two-term shopping mission truth),
and it may **never wear half a dual name**: dual mates are searched only among
mission-grade frames (`MISSION_GRADE_LOGIT`). Before this refinement a
weak-signal corpus garnished with two calendar titles could dual-assemble
"deploy & calendar" — truthful words, wrong register. Recorded as the
calibration-law precedent for all future frames.

## H4 — yield is not failure, and absence is silent by construction

**Decision.** Two distinct typed-yield shapes answer differently:
insufficient-evidence (`details: {yield: true}`) says "next rung, please —
but I am healthy", and capability-absence (`{yield: true, absent: true, why}`)
says "I will never answer in this context". Hosts (`worker-hosts.ts`) skip
`ladder.noteFailure` for exactly `details.yield === true` — a yield is never a
breaker strike (L1 pins: breaker cell stays closed/count-0 while the heuristic
rung answers the same attempt).

**Sync-composition ruling.** Roots compose synchronously (ADR-025) but
capability detection is async; the deferred rung
(`createDeferredOnDeviceNamer`) registers inert and resolves the model
single-flight on first execution, answering the absence yield forever if the
model cannot load. `createOnDeviceNamer(host?)` remains the async factory for
probes/tests (returns `null`). The ai-lanes probe continues to show the
rung's breaker cell either way — evidence without banners (Principle 22).

## H5 — flag-on shipped by CI gate, not by dormant runtime flag

**Ruling.** M7's "flag-off until shadow-pass" law is satisfied by making the
shadow evaluation a **merge-blocking build gate** (`check:shadow-eval` in
`ci:all` + PR workflow): code only lands green, and the pipeline
guards every subsequent edit. No dormant runtime flag ships — a flag nobody
flips is a lie about reachability, and a flag that could flip off would make
the ladder shape environment-dependent beyond the capability detection the
matrix already sanctions. The evaluation harness — not a flag — is the
delivery of the row's "no flag-off rule" wording.

## H6 — shadow evaluation: frozen metric, seeded corpus, independent runner

**Decision.** Corpus: `ops/shadow-corpus/missions.json` — 551 rows across 12
cluster families (20 signal clusters, `mixed`, four adversarial
sub-families), emitted by a seeded generator (`mulberry32(0x1ed9e)`); the
evaluator byte-compares committed-vs-regenerated before judging. Templates
carry `fires` tags = the author's contract with the machine; the gate fails
when machine-top escapes the union (one real escape was caught + fixed during
bring-up: a react-pool title containing "guide" dual-fired `docs`).

Metric: frozen in `docs/ai-shadow-eval-v1.md` — nine gates; headline results
at ship: precision 1.0, recall 1.0, fabrications 0, reachability 1.0,
**beats-heuristic margin 0.953** (floor 0.50), stamp vocabulary exact,
machine agreement 1.0. Runner independence: `run.mjs` imports nothing from
`src/`; it re-implements the scorer from the frozen constants and audits the
shipped machine against that law. An evaluator importing the code under test
grades its own homework — banned.

## H7 — honest vocabulary, §5.13 class

**Decision.** Names assemble exclusively from lexicon display words plus
`{tabCount} tabs` — the model cannot emit a token it cannot point to in the
weight table (schema `ondevice-fwd-v1`, `schemaV: 1`). Mission-name input was
extended additively (`tabs?: readonly MissionNameTab[]`, caps 50 tabs × 200
chars) so the corpus is evidence the mission ledger already holds — no new
collection, no per-tab URLs (ADR-034 hygiene; rootDomain only, discarded tabs
contribute title but not domain). English-only is a stated honesty boundary,
not a silent one: non-English corpora score nothing and yield (N3,
shadow-corpus devanagari family).
