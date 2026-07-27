# Shadow corpus (E8-T03) — `missions.json`

The seeded evaluation set behind `check:shadow-eval` and the roadmap's E8-T03
completion sentence ("OnDeviceML beats heuristic on the shadow evaluation set
≥ threshold"). 551 mission rows, 12 cluster families.

## Provenance law

- **Derived, not curated in place.** `gen.mjs` (mulberry32, seed `0x1ed9e`) emits
  `missions.json` deterministically; `ops/shadow-eval/run.mjs` byte-compares the
  committed JSON against a fresh emission before judging anything. Hand edits
  fail the gate. Regenerate with `pnpm gen:shadow-corpus`.
- **Synthetic-only** (fixture corpus ethic): authored title templates, RFC
  2606-style `.example` domains, inert coinage slots (`kestrel`, `quillon`…)
  so no real user data, brand, or site enters the corpus.

## Row shape

| field         | law                                                                            |
| ------------- | ------------------------------------------------------------------------------ |
| `id`          | `<cluster>-<nn>`                                                               |
| `cluster`     | one of 20 signal clusters · `mixed` · `adversarial`                            |
| `tabCount`    | `tabs.length` (never lies)                                                     |
| `rootDomains` | unique tab domains, first-appearance order (heuristic rung's only evidence)    |
| `takenAt`     | seeded wall-clock within ~30 days of the anchor                                |
| `tabs`        | `[{title, rootDomain}]` — the on-device rung's corpus                          |
| `expect`      | `name` \| `yield` — the honesty oracle                                         |
| `accepted`    | frame ids the machine may lawfully put on top (union of template `fires` tags) |

## Template law (authoring discipline)

Every title template carries a `fires` tag listing exactly the lexicon frames its
words can trigger under the full-word boundary law ("components" never fires
`component`; "subledger" never fires `ledger`; normalized dead needles like
`" rust "` are banned by `check:ondevice-model` D5). If the shipped machine's
top frame escapes a row's `accepted` union, the eval fails — authoring debt and
machine drift are the same red gate.

Adversarial sub-families (all `expect: yield` except named-chaff):

- `devanagari` — non-English corpora score nothing; yield is the only answer.
- `eng-thin` — vague English with zero lexicon terms.
- `chaff-single` — exactly one chaff term (posterior below the 0.6 floor).
- `chaff-multi` — the only named adversarial rows: chaff register may name when
  it is the _entire_ story (z ≥ 0.6 law), never as half of a dual.
- `trap-inside` — lexicon-looking tokens glued inside longer words
  (`githubber`, `typescripting`, `preactifying`); the boundary law must refuse.
