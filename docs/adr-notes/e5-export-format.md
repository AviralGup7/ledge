# ADR note — E5-T04 export-format spec doc (public covenant v1)

**Status:** decisions taken while writing `docs/export-format-v1.md` (the ADR-038 public
contract (1) / ADR-045 read-forever promise) and its examples-validated tripwire. No ADR
reversals; the doc composes within ADR-038 (public contract = the format spec, no programmatic
API), ADR-040 (size/time guards — reader-side expectations only, §8), ADR-045 (canonical model
= projection snapshot; chunk-verify-then-present; versioned read-forever), EES §2.14 (full
provenance; never silent-partial), EES §6 (ExportRendererPort failure law).
**Authored:** 2026-07-26, E5-WP3 close-out.

Each entry: the question, the decision, the why. **[follow-up]** names the milestone that owns
the remaining work.

---

## 1. Authority and class of the document

**Question:** is the export spec a new kind of artifact, or an instance of an existing class?

**Decision:** an instance of the existing **locked-covenant doc** class — same posture as
`docs/journal-segment-format-v1.md`: status line (locked covenant, formatV, gate, owners),
"as implemented and gate-proven" framing, per-law tripwires naming executable tests, and a
final versioning-covenant section (its §9 mirrors the journal doc's §9 change discipline).

**Why:** ADR-038 makes the export format public contract (1) — one of only three things we
promise outsiders. A promise that deviates from the repo's proven covenant shape invites a
third, weaker standard. Reusing the class keeps the read-forever promise (ADR-045, quoted
verbatim in the doc's header) anchored to the same "ADR + version bump + doc + tripwires in
one PR, never a silent edit" discipline the journal already enforces.

## 2. "Examples validated" — the AC's executable reading

**Question:** roadmap E5-T04's exit column says "Versioned, examples validated". What makes an
example in a markdown doc _validated_ rather than decorative?

**Decision:** the doc's four example blocks (json / html / md / worked seal) are
**renderer-produced bytes**, pinned by `src/infrastructure/exporters/export-format-doc.test.ts`
in the unit lane:

- marker grammar couples doc and test: `<!-- covenant-example: <key> -->` +
  `<!-- prettier-ignore -->` lines immediately ahead of each marked fence — no other coupling;
- the test renders a **fixed covenant model** (checked into the test) through
  `buildModel` → `jsonParts`/`htmlParts`/`mdParts` → `assembleVerified` and requires
  **byte-equality** with each marked block, with a both-ways census (a renamed marker or a
  missing block fails loud);
- `COVENANT_EXAMPLES_UPDATE=1` regenerates the blocks from the live renderers — the one
  lawful way to change them, mirroring the perf harness's update-mode precedent
  (`PERF_UPDATE`); covenant §9 discipline says the regeneration rides the same PR as the
  renderer change.

**Why byte-equality, not structure-equality:** the format's determinism law (same truth ⇒
same bytes ⇒ same checksums) is itself part of the covenant — the seal example in §7 only
means anything if the bytes are stable. A structural check would let drift in separators,
indent, or trailing newline pass silently; those are exactly the bytes a third-party slicing
parts per §4 depends on. Negative control run at ship time: perturbing one hex digit in the
doc fails the lane; restoring passes.

**Why `prettier-ignore` rides every marked fence:** prettier's embedded-language formatting
(`embeddedLanguageFormatting`, default `auto`) would rewrite json/html/markdown fence content
to _prettier's_ canon — not the renderer's bytes — breaking the pin the first time anyone runs
the formatter. The repo-wide prettier config is untouched (shared config is law); the
exception moves to node-scoped comments on exactly the blocks that must stay verbatim.

## 3. The covenant model in the test is checked in, not re-derived

**Question:** should the test import shared fixtures (services testkit, view-row factories)?

**Decision:** no — the covenant fixture is small, explicit, and **frozen inside the test
file** (two missions, four tabs, one dropped ref, fixed `generatedAt`/`build`/`canonRulesV`).

**Why:** the example is a public artifact's face. If it changed whenever a shared factory
grew a field or a testkit renamed a constant, the doc would drift for reasons nobody chose.
Freezing the model makes every example change an intentional, reviewable diff — the same
posture as the journal doc's golden fixtures.

## 4. What the example shows (and deliberately shows)

**Question:** should the covenant's primary example be the smallest happy path?

**Decision:** the example exercises the grammar's _laws_, not just its shape: deterministic
mission ordering (`Reading list` before `Trip planning` by `createdAt`), one tab carrying the
optional `urlCanonHash`, **one dropped mission→tab ref surfacing
`diagnostics.droppedTabRefs: 1`**, and one loose tab (which also makes the `loose:<i>` part
grammar and the `], "looseTabs": [` prefix visible in byte-order).

**Why:** §2.4's dropped-ref counting is the no-silent-partial law's arithmetic surface (EES
§2.14) — the thing a reader most needs to see demonstrated, because it is the field that says
"the artifact is exactly this complete". A pure happy-path example would leave the most
consequential field unexplained.

## 5. Normative vs informational in the JSON grammar

**Question:** are key order and indent part of the reader contract?

**Decision:** no — the doc states byte-determinism (key order, two-space indent, four-space
nested members, trailing newline) as a property of _this_ renderer that makes checksums
rebuildable, and binds readers to parse **by name** (§8.2), never positionally. The part
grammar and checksum arithmetic _are_ normative (they define verification); presentation
details are informational except where the separator/concatenation law makes them
load-bearing.

**Why:** freezing presentation minutiae into the reader contract would make lawful formatting
niceties impossible to change without a `formatV` bump; freezing the seal arithmetic is what
the read-forever verify story actually needs. This mirrors the journal doc's split (record
shapes normative, scanner behaviour contractual, walk order an implementation property).

## 6. Scope discipline — the doc describes what E5-T03 shipped

**Decision:** the covenant documents the format **as built** in E5-T03 (SW-composed v1), and
references the offscreen streaming door only as the producer-side seam (§3, the
`RenderChunk` frame shape); it makes no promises beyond ADR-045/EES §2.14. The
`ExportReady` fetch machinery remains the deferred door recorded in `e5-exporters.md` §3.2 —
this doc names the journal's recorded seal (`ExportCompleted.manifestChecksum`) and does not
pre-commit a download surface.

**Why:** a public covenant that advertises unshipped machinery is a promise we cannot yet
keep; ADR-038's whole point is that promises are few and absolute. **[follow-up]** E5-T05
(`parser-ledge-export`) becomes the first-party reader this covenant binds (§8/§9 round-trip
law) — its import path is the covenant's first full-dress consumer tripwire.
