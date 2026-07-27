# E8-T04 · Summaries v1 (park-time one-liner + thread) — decision record

Roadmap row: "E8-T04 Summaries v1 (park-time one-liner + thread) | Spec §6.3
artifacts | E8-T03 | L | summarizer binding | Fail-down law: heuristic when
low-fidelity". State: **shipped** — the summarizer capability is bound into
both existing ladder rungs (`'mission-summary'` rides the same providers,
breaker cells, exactly-once pipeline, and hinged commit), the artifact
covenant was extended additively (`thread?`), and the completion criterion is
proven by unit L1 and shadow-eval G10/G11 in CI.

Numbering continues the E8 ledger: F1–F4 (`e8-ai-queue.md`), G1–G3
(`e8-isolation-gates.md`), H1–H7 (`e8-ondevice-provider.md`). This note records
**I1–I5**.

---

## I1 — summaries bind INTO the ladder; no new pipe, one new kind

**Decision.** `'mission-summary'` joins `AiJobKind`; both rungs declare the
capability and dispatch inside `run()`. The on-device rung answers from the
SAME verified model/evidence (E8-T03 H2/H3); the heuristic rung answers the
§6.3 counts form. No new ports, no new queue, no new commit path —
`enqueueMissionSummary` mirrors `enqueueMissionName` over the shared
`enqueueJob` law, and subjectKey coalescing is kind-keyed (a queued name job
and a queued summary on the same subject never collapse into each other).

**Why one providerId per rung (not a summarizer-duplicate provider).** Breaker
cells key on `providerId`; two objects with id `ondevice` would collide into
one cell and duplicate probe rows. The dependency IS one — the verified model
— so the object is one, with two capabilities. The constitutional law
("heuristic ladder rung always exists") then holds for summaries by
construction, because the same `heuristic-`prefixed rung covers both kinds.

## I2 — the artifact covenant grew one optional field (A-09 honored)

**Decision.** `MemoryArtifactWritten` keeps `schemaV: 1`; value stays the
ONE-LINER (the default surface, Spec §6.3) and the archive-time THREAD
narrative rides the additive optional field `'thread?': 'string'`. Append-only
law respected: additive with `?` suffix, this note is the A-09 record, and the
L3 unit test ratchets the registry shape. A JSON-in-string payload was
rejected (the registry says `value: 'string'` — packing structures inside a
string lies by letter while breaking covenant by spirit). Two artifacts per
job was rejected (the hinged exactly-once proof is one-artifact-per-job;
k>1 would re-open the E8-T01 hinge law).

Boundary law in `domain/memory/artifact.ts`: `thread` when present must be
non-empty (an empty thread is a lie about absence) and ≤ 2,000 chars
(`ARTIFACT_THREAD_MAX_CHARS`; the template sentences never approach it — the
cap is the boundary, not a target).

## I3 — fail-down is a corpus-scale law, not a code path

**Decision (the row's completion criterion).** The on-device summarizer
inherits the naming calibration floor: thin evidence ⇒ typed YIELD (never a
low-fidelity paragraph — Spec §6.3 "no placeholder gibberish"), and the
heuristic rung answers with the counts form: "N tabs across K domains, largest
presence X (M tabs)" + thread ("Domain family X appears most…"). Proof
machinery, layered:

- **Unit L1** — devanagari/thin corpus through the full host+ladder: artifact
  outcome is `heuristic`, breaker cell stays closed/0 (yield ≠ strike, H4).
- **Shadow-eval G10 fail-down totality** — every corpus row (551/551) carries
  SOME lawful summary: 532 on-device + 19 heuristic (the yield rows answered
  by the fail-down form, exactly the §6.3 "name + counts remain" semantics).
- **Shadow-eval G11 one-liner discipline** — every emitted one-liner honors
  the 120-char calm-card budget and the no-urgency-punctuation law.

**Portability ruling (mirror, don't call).** The eval runner re-implements
the heuristic one-liner with the format's WORST-CASE time token (`12:59 pm`)
instead of `formatLabelTime(takenAt)` — a wall-clock call inside the runner
would poison G7 determinism and make the gate machine-dependent. The runtime
format is pinned by the unit lane; the eval audits the shape law.

## I4 — honest vocabulary extends to sentences, never to adjectives

**Decision.** One-liner: `{name} — across {K} domains — anchors: {terms}` with
budget-driven tail-drop (anchors shed from the end before counts shrink or the
hint drops — dropping is honest, slicing mid-word is not). Thread: three
template sentences (record span → evidence center → domains in play + parked
time), with `Name on record: {hint}.` when the producer carries a current-best
name hint (input vocab, capped at 120). Every contentful token remains
point-at-able: lexicon displays, kernel-confirmed terms, input domains,
counts, producer hints. The disclosure of shallowness is owned by the
confidence band (§6.11), never by prose — the heuristic thread states counts,
it does not editorialize about its own depth.

`CalibratedName.dualWith` was added so the summarizer recaps anchors from the
EXACT frames the calibration law dual-bound (no re-derived guesses).

## I5 — hints are producer data; privacy law is symmetric across rungs

**Decision.** `missionNameHint` is opaque producer input (E8-T05+ flows pass
the current best naming artifact when one exists; absent ⇒ the summary speaks
counts only). Sanitize-at-provider law (total over envelope violations): caps
re-enforced inside both rungs. Parked-tab privacy mirrors the E8-T03 corpus
law on BOTH rungs: discarded tabs contribute to `tabCount` only — their
rootDomain never enters the on-device corpus NOR the heuristic presence tally
(H4 unit test: a discarded `secret.example` appears nowhere in either
surface). Timezone law inherits E8-T01: `takenAt` formats in the runner's
local tz, replay-deterministic per machine, never a speculation vector.
