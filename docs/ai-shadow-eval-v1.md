# ai-shadow-eval-v1 — frozen shadow-evaluation metric (E8-T03)

Status: **frozen as CI law** (`pnpm check:shadow-eval`, in `ci:all` + PR gate).
Owner surface: `ops/shadow-eval/run.mjs` (gate), `ops/shadow-corpus/` (seeded
corpus), `ops/shadow-eval/report.json` (evidence snapshot).

This document freezes what "OnDeviceML beats heuristic ≥ threshold" means so
the claim can never quietly rot: the metric, the corpus, the thresholds, and
the trust chain are versioned here and enforced mechanically. Changing any of
them requires editing **this document in the same commit** as the code change
(and an ADR note if thresholds move downward).

## 1 · What is measured

Rows are missions: `{tabs[{title, rootDomain}], rootDomains, tabCount,
takenAt, expect, accepted}`. The on-device provider's forward pass
(title/domain corpus → WASM-confirmed term evidence → posterior calibration)
is compared against the rung-1 heuristic label (`N tabs · domain words ·
time`) **on the topic dimension only** — the heuristic is time-and-domain
truthful but semantically shallow by design (confidence 0.55, LOW band,
§6.11 neutral frame). The margin must therefore be large, not marginal.

**Topic accuracy (strict word law).** A rung's answer is _correct_ when its
top frame ∈ the row's `accepted` union (for dual names, the mate must also ∈
`accepted`). For the heuristic, a label word (second-level domain fragment)
must equal an accepted frame id **or** its display string, case-insensitive —
"deploy" credits `devops`; "reactjs" credits nothing. Yields count as misses
for the on-device side; the heuristic always answers, it forfeits nothing by
silence — the comparison deliberately denies the ML rung any free lunch.

## 2 · Gates (all nine must pass)

| gate | law                                                                        | threshold |
| ---- | -------------------------------------------------------------------------- | --------- |
| G1   | fabrications (named on `expect: yield` rows)                               | `= 0`     |
| G2   | precision (`top ∈ accepted` over named rows)                               | `≥ 0.95`  |
| G3   | recall (named over `expect: name` rows)                                    | `≥ 0.85`  |
| G4   | term reachability (every lexicon term fires ≥ 1 row)                       | `= 1`     |
| G5   | **beats-heuristic margin** (ondeviceAcc − heuristicAcc, nameable)          | `≥ 0.50`  |
| G6   | confidence vocabulary ⊆ `{0.88, 0.85, 0.72, 0.64}` (frozen stamps)         | `= 1`     |
| G7   | determinism (two full passes, byte-equal digest)                           | `= 1`     |
| G8   | totality (rows judged == rows in corpus)                                   | `= 1`     |
| G9   | machine agreement (WASM machine == JS law, per-term verdicts)              | `= 1`     |
| G10  | fail-down totality (rows with SOME lawful summary: ondevice or heuristic)  | `= 1`     |
| G11  | one-liner discipline (≤ 120 chars ∧ no urgency punctuation, both families) | `= 1`     |

G1 and G9 are honesty gates (never invent; the machine IS the law). G4 exists
because an unreachable lexicon term is dead weight pretending to be
capability. G5 is the roadmap's completion sentence made arithmetic.
G6 pins the R7 calibration ladder end-to-end (unit lane pins the constants;
this gate pins every emitted value). **G10/G11 are the E8-T04 amendment**
(append-only, `docs/adr-notes/e8-summaries-v1.md` I3): Spec §6.3's fail-down
law runs at corpus scale — the on-device one-liner answers calibrated rows,
the heuristic counts form answers the rest, and nothing anywhere writes
placeholder prose.

## 3 · Current evidence (frozen at ship time)

`ops/shadow-eval/report.json` — 551 rows (532 `expect: name` incl. the seven
named chaff-multi rows, 19 `expect: yield` across the four adversarial
sub-families):

- precision `1.0`, recall `1.0`, fabrications `0`
- term reachability `1.0` (all 127 lexicon terms fire)
- on-device topic accuracy `1.0`, heuristic `0.047` → **margin `0.953`**
  (gate floor `0.50`)
- machine agreement `1.0` across every row × every term (≈ 70k per-term
  verdicts plus full-set equality per row)
- E8-T04 amendment: fail-down totality `551/551` (532 on-device one-liners +
  19 heuristic counts-form answers — every yield row lands the §6.3
  name+counts form); one-liner discipline `1.0` (120-char budget ∧ calm
  punctuation, both families)

## 4 · Trust chain (each link a mechanical gate)

1. `tools/ondevice-model/lexicon.json` — human-curated stems (English-only,
   full-word law).
2. `check:ondevice-model` — re-emits artifacts from the lexicon and
   byte-compares with the committed `model/*.ts`; re-verifies the sha256
   stamps; validates + instantiates the kernel; D5 rejects non-normal terms.
3. `ops/shadow-corpus/gen.mjs --check` — the committed corpus re-derives
   byte-exactly from the seed (run inside `check:shadow-eval`).
4. This runner — independently re-implements the scorer (imports nothing from
   `src/`); audits the shipped WASM machine against the law at corpus scale.
5. Unit lane M1–M4 — ties the _runtime loader + provider factories_ to the
   same law over the same committed bytes.

Any hand-edit to weights, kernel, corpus, or constants breaks a different red
gate. There is no edit path that keeps all five links green while changing
what the machine decides.

## 5 · Explicit non-goals (v1)

- **English-only lexicon** (honesty law): non-English rows must yield, and
  they do (G1 covers). Multilingual frames are a v2 ADR-note candidate.
- **Polysemy** — "rust" the word vs. the language is unresolved; v1 matches
  words, not senses. Corpora must not author trap polysemes expecting
  mind-reading.
- Per-language / per-domain slices — a v2 candidate once the corpus grows.
