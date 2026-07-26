# Ledge Export Format — v1

**Status:** locked covenant (formatV = 1) · **Date:** 2026-07-26 · **Gate:** E5-T04 (roadmap §E5)
**Owners:** `src/infrastructure/exporters/**` · **Reads:** this spec is public contract (1) of
ADR-038 ("export format spec, versioned, documented, read-forever") and the exporter row of
EES §2.14.

**Promise (ADR-045):** “The export format is versioned and supported read-forever — this file is
a promise, not an artifact.”

This document specifies the bytes Ledge's export pipeline presents. It describes the format
**as implemented and gate-proven** — every law below is executable in the repo (each section
names its tripwire, and the examples in §4–§7 are byte-compared against the shipped renderers
by the unit lane). A grammar change is an ADR + a `formatV` bump + this doc + tripwires in the
same PR, never a silent edit (§9).

Like the journal segment format (`docs/journal-segment-format-v1.md`), one checksum vocabulary
and one reader covenant (§8) apply across every Ledge artifact.

---

## 1. Artifacts and scopes

One export = one **canonical model** (§2) rendered into one artifact per requested format. The
renderers are pure functions of the model: same truth ⇒ same bytes ⇒ same checksums (the
round-trip law's foundation).

| Format key | Grammar | Nature                                                                                                    | Renderer      |
| ---------- | ------- | --------------------------------------------------------------------------------------------------------- | ------------- |
| `json`     | §4      | **Fidelity master.** Self-describing; the only format an importer (first- or third-party) may parse back. | `render-json` |
| `html`     | §5      | Standalone presentation; opens offline from the file alone; **lossy, never parsed back.**                 | `render-html` |
| `md`       | §6      | Notes-style presentation; **lossy, never parsed back.**                                                   | `render-md`   |

Scope selects the truth the model covers:

- `'all'` — every non-trash mission plus every loose (unreferenced) non-trash tab;
- `{ "mission": "<missionId>" }` — exactly one mission and its resolvable tabs.

Format order inside one export run is canonical (`json`, `html`, `md` — requests are re-ordered,
never duplicate-rendered). The journal's `ExportCompleted.manifestChecksum` records the **JSON**
document's `manifestChecksum` (§3) as the export's durable seal.

## 2. The canonical model

The canonical model is a **projection snapshot** (ADR-045) built from the missions/tabs read
model — never from the raw journal, never from the (deletable) search index. Renderers consume
only this model, so §2's laws hold identically across §4–§6.

### 2.1 Provenance block (EES §2.14 “full provenance”)

| Field         | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `format`      | `"ledge-export"` (constant).                                                            |
| `formatV`     | `1` — this document's version row. Anything else ⇒ refuse loudly (§8).                  |
| `app.name`    | `"Ledge"`.                                                                              |
| `app.build`   | The build's contract identity: fnv1a64 of the message registry, 16 lowercase hex chars. |
| `canonRulesV` | canon ruleset version in force at export time (provenance, never row-derived).          |
| `generatedAt` | Epoch milliseconds (UTC) of the export. §5/§6 render it ISO-8601 UTC.                   |
| `scope`       | `"all"` or `{ "mission": "<missionId>" }` (§1).                                         |

### 2.2 Mission objects

| Field          | Type                               | Law                                             |
| -------------- | ---------------------------------- | ----------------------------------------------- |
| `missionId`    | string                             | The truth id.                                   |
| `name`         | string                             | May be empty (unnamed missions are lawful).     |
| `state`        | `"live" \| "parked" \| "archived"` | Trashed missions are never exported.            |
| `concluded`    | boolean                            |                                                 |
| `createdAt`    | epoch ms, optional                 | **Absent, never null**, when absent from truth. |
| `lastActiveAt` | epoch ms, optional                 | Absent, never null.                             |
| `tabs`         | tab objects (§2.3)                 | The mission's declaration order is preserved.   |

### 2.3 Tab objects

| Field          | Type                    | Law                                                                                                                                         |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`          | string                  | The observed URL as recorded.                                                                                                               |
| `title`        | string                  | May be empty; §5/§6 fall back to the URL for display.                                                                                       |
| `domain`       | string                  |                                                                                                                                             |
| `state`        | `"live" \| "kept"`      | Trashed tabs never cross the front door (they surface in §2.4 instead).                                                                     |
| `urlCanonHash` | 16-hex string, optional | fnv1a64 content-hash of the canonical form — a dedup **hint**, never an equality oracle (fnv1a64 is non-cryptographic). Absent, never null. |
| `firstSeenAt`  | epoch ms, optional      | Absent, never null.                                                                                                                         |
| `lastActiveAt` | epoch ms, optional      | Absent, never null.                                                                                                                         |

### 2.4 `diagnostics` — the no-silent-drop arithmetic surface

| Field            | Law                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `droppedTabRefs` | Count of mission→tab references that could not resolve to a non-trash tab row (missing **or** trashed). Dropped, counted — **never fabricated**. |

### 2.5 Truth and ordering laws

1. **Trash exclusion:** trashed missions and trashed tabs never appear in any artifact.
2. **Loose partition:** a non-trash tab referenced by no exported mission appears in
   `looseTabs`, exactly once; every exported tab appears either in its mission or in
   `looseTabs`, never both.
3. **Deterministic order:** missions sort by `(createdAt, missionId)`; a mission's tabs keep
   declaration order; loose tabs sort by `(firstSeenAt, ledgeTabId)`. Same truth ⇒ same bytes.
4. **Optional fields:** absent-from-truth fields serialize as **absent keys**, never `null`
   and never defaulted-in.

_Tripwires:_ `src/infrastructure/exporters/model.test.ts`.

## 3. Streaming parts and checksum arithmetic

Every renderer emits its document as an ordered stream of parts; the assembler is the only
place parts become an artifact (ADR-045 “chunk-verify-then-present”).

```
RenderChunk = { seq: 0,1,2,…, partId: string, text: string, checksum: 8-hex }
```

**Checksum vocabulary (one function across Ledge artifacts):** `crc32Hex` from the canon
kernel (`src/shared-kernel/canon`) — CRC-32 rendered as 8 lowercase hex chars; the journal
segment image (`docs/journal-segment-format-v1.md` §4) uses the same function.

1. **Per-part seal:** `checksum = crc32Hex(part.text)`; `bytes` = UTF-8 length of `part.text`.
2. **Manifest:** the ordered list of `{ partId, checksum, bytes }` for every **data** part,
   plus `partCount` and `totalBytes` (the sum of `bytes`).
3. **Manifest seal:** `manifestChecksum = crc32Hex(lines)` where `lines` is the data parts'
   `partId:checksum` strings, in document order, joined with `"\n"`. A worked example: §7.
4. **Sealer, never sealed:** a renderer may embed its manifest in the document (the `json`
   grammar does, §4); that transport part (`partId: "manifest"`) is **excluded from its own
   list** — the manifest seals data parts only.
5. **Separator law:** array separators ride **inside** the part that precedes them, so the
   document is byte-exactly the concatenation of its parts in order.
6. **Verify-then-present (producer law, EES §6):** the assembler re-computes every chunk's
   checksum before accepting it; a mismatch discards the buffer and re-runs the whole render,
   up to 2 extra attempts (`E_RENDER_CHUNK` retry signal); exhaustion ⇒ `E_RENDER_FATAL`.
   A partial artifact is never presented as an export (EES §2.14 “never silent-partial”).

Readers streaming a v1 JSON artifact **should** re-run steps 1–3 over the parts they slice
(via the §4 grammar) and refuse a document whose manifest fails to verify.

_Tripwires:_ `src/infrastructure/exporters/stream.test.ts`, `renderers.test.ts`
(“embedded manifest ≡ assembler-sealed manifest”).

## 4. The JSON document (fidelity grammar)

One JSON document, two-space indent (the grammar's indent unit), nested array members
re-indented four spaces, a final newline after the closing brace:

```
{ "format": "ledge-export", "formatV": 1, "app": {…}, "canonRulesV": …,
  "generatedAt": …, "scope": …,
  "missions": [ <mission objects> ],
  "looseTabs": [ <tab objects> ],
  "diagnostics": { "droppedTabRefs": … },
  "manifest": { "parts": […], "partCount": …, "totalBytes": …,
                "manifestChecksum": "…" } }
```

Part grammar (what each `partId` seals; §3's concatenation law makes the document exactly the
parts joined in order):

| partId         | Content                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `head`         | Everything through `"missions": [` — provenance + scope.                                                                                 |
| `mission:<id>` | One mission object per part, trailing `,` included when a further mission part follows.                                                  |
| `loose:<i>`    | Up to **500** tab objects per part (`i` zero-based); the first carries the `], "looseTabs": [` opening.                                  |
| `tail`         | `],` closing the open array, then the `"looseTabs"` line (when no loose part exists: `"looseTabs": [],` inline) and `"diagnostics": …,`. |
| `manifest`     | The manifest object + document close (`}\n`). Transport — excluded from the seal (§3.4).                                                 |

Edge laws: **empty arrays stay valid** — an empty export renders `"missions": [],` and
`"looseTabs": [],` inline with `head`→`tail` adjacency and a two-part seal. Hostile strings
(titles containing quotes, backslashes, `</script>`) ride as ordinary JSON string content.

Key order inside objects is a byte-determinism property of this renderer, **not** reader
contract — readers parse by name (§8).

**Example** (§2.5's ordering and §2.4's diagnostics both visible: `Reading list` precedes
`Trip planning`; `Trip planning` references a tab row that no longer exists, so
`droppedTabRefs` counts it; `t-loose` has no referencing mission):

<!-- covenant-example: json -->
<!-- prettier-ignore -->
```json
{
  "format": "ledge-export",
  "formatV": 1,
  "app": {"name":"Ledge","build":"a94f3c21807bc6d5"},
  "canonRulesV": 1,
  "generatedAt": 1785024000000,
  "scope": "all",
  "missions": [
    {
      "missionId": "m-alpha",
      "name": "Reading list",
      "state": "parked",
      "concluded": false,
      "createdAt": 1784851200000,
      "lastActiveAt": 1785013200000,
      "tabs": [
        {
          "url": "https://example.com/articles/tab-suspension",
          "title": "The case for tab suspension",
          "domain": "example.com",
          "state": "kept",
          "urlCanonHash": "a1b2c3d4e5f60718",
          "firstSeenAt": 1784851200000,
          "lastActiveAt": 1785013200000
        },
        {
          "url": "https://example.org/papers/event-sourcing",
          "title": "Event sourcing field notes",
          "domain": "example.org",
          "state": "live",
          "firstSeenAt": 1784854800000,
          "lastActiveAt": 1785016800000
        }
      ]
    },
    {
      "missionId": "m-beta",
      "name": "Trip planning",
      "state": "live",
      "concluded": false,
      "createdAt": 1784937600000,
      "lastActiveAt": 1785020400000,
      "tabs": [
        {
          "url": "https://example.net/flights?to=blr",
          "title": "Flights to BLR",
          "domain": "example.net",
          "state": "kept",
          "firstSeenAt": 1784952000000,
          "lastActiveAt": 1785020400000
        }
      ]
    }
],
  "looseTabs": [
    {
      "url": "https://example.com/recipes/masala-dosa",
      "title": "Masala dosa, step by step",
      "domain": "example.com",
      "state": "live",
      "firstSeenAt": 1785006000000,
      "lastActiveAt": 1785022200000
    }
],
  "diagnostics": {"droppedTabRefs":1},
  "manifest":   {
    "parts": [
      {
        "partId": "head",
        "checksum": "990b0dc1",
        "bytes": 186
      },
      {
        "partId": "mission:m-alpha",
        "checksum": "3eddb279",
        "bytes": 815
      },
      {
        "partId": "mission:m-beta",
        "checksum": "937d1558",
        "bytes": 470
      },
      {
        "partId": "loose:0",
        "checksum": "78fe8913",
        "bytes": 258
      },
      {
        "partId": "tail",
        "checksum": "e4ae51f6",
        "bytes": 42
      }
    ],
    "partCount": 5,
    "totalBytes": 1771,
    "manifestChecksum": "ffb25ace"
  }
}

```

_Tripwires:_ `src/infrastructure/exporters/renderers.test.ts` (grammar validity, determinism,
round-trip fidelity, loose-batch arithmetic, empty-model validity).

## 5. The HTML document (standalone law)

A single self-contained HTML5 document (EES §12: “renders standalone offline from export
alone”):

- **Self-contained.** One inline `<style>` block; **no** scripts, `src=`, `@import`, `url(`,
  fonts, images, or external references of any kind. Exported URLs appear only as data anchors
  (`<a href="…">`) — user-invoked, never auto-fetched.
- **Escaping law.** Every model string passes one escaper before entering markup, in this
  order: `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#39;`. A hostile title must
  never break the document's structure.
- **Structure.** `<h1>` title, one provenance `<p class="meta">` (format, build, canonRulesV,
  ISO-8601 `generatedAt`), one `<section>` per mission (`<h2>` name + count, `<ol>` of tab
  anchors with domain spans), then a `Loose tabs` section when the model has loose tabs.
- **Lossy by design.** Mission ids, states, timestamps, and diagnostics do **not** appear; no
  manifest is embedded. §8: this document is a presentation, never an import source.
- **Parts.** `head` · `missions:<i>` (up to **100** mission sections per part, `i` zero-based) ·
  `tail` (loose section + `</body>\n</html>\n`).

**Example** (same covenant model as §4):

<!-- covenant-example: html -->
<!-- prettier-ignore -->
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ledge export</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.5}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}
ol{padding-left:1.4rem}li{margin:.25rem 0}a{color:#0645ad;text-decoration:none}a:hover{text-decoration:underline}
.meta{color:#666;font-size:.85rem}.count{color:#666;font-weight:400}
</style>
</head>
<body>
<h1>Ledge export</h1>
<p class="meta">format ledge-export v1 · build a94f3c21807bc6d5 · canonRulesV 1 · generated 2026-07-26T00:00:00.000Z</p>
<section>
<h2>Reading list <span class="count">(2)</span></h2>
<ol>
<li><a href="https://example.com/articles/tab-suspension">The case for tab suspension</a> <span class="meta">example.com</span></li>
<li><a href="https://example.org/papers/event-sourcing">Event sourcing field notes</a> <span class="meta">example.org</span></li>
</ol>
</section>
<section>
<h2>Trip planning <span class="count">(1)</span></h2>
<ol>
<li><a href="https://example.net/flights?to=blr">Flights to BLR</a> <span class="meta">example.net</span></li>
</ol>
</section>
<section>
<h2>Loose tabs <span class="count">(1)</span></h2>
<ol>
<li><a href="https://example.com/recipes/masala-dosa">Masala dosa, step by step</a> <span class="meta">example.com</span></li>
</ol>
</section>
</body>
</html>

```

_Tripwires:_ `renderers.test.ts` (“is self-contained”, “escapes hostile titles”).

## 6. The Markdown document (notes grammar)

A single CommonMark-friendly notes document:

- **Grammar.** `# Ledge export`, a provenance blockquote (`> format ledge-export v1 · build …
· canonRulesV … · generated <ISO-8601>`), one `## <name> (<count>)` section per mission,
  tab lines `- [<title or url>](<url>)`, and a `## Loose tabs (<count>)` section when the
  model has loose tabs.
- **Escaping law — neutralization, not absence.** Link text (titles, mission names):
  whitespace runs collapse to one space, `\`→`\\`, `[`→`\[`, `]`→`\]`, trimmed — so injected
  brackets break the link grammar and collapsed newlines deny any injected heading its line
  start. URLs: whitespace→`%20`, `(`→`%28`, `)`→`%29`.
- **Lossy by design**, exactly like §5 (no ids, states, timestamps, diagnostics, or manifest).
- **Parts.** `head` · `missions:<i>` (up to **200** mission sections per part, `i` zero-based) ·
  `tail` (the loose section, or empty).

**Example** (same covenant model as §4):

<!-- covenant-example: md -->
<!-- prettier-ignore -->
```markdown
# Ledge export

> format ledge-export v1 · build a94f3c21807bc6d5 · canonRulesV 1 · generated 2026-07-26T00:00:00.000Z

## Reading list (2)

- [The case for tab suspension](https://example.com/articles/tab-suspension)
- [Event sourcing field notes](https://example.org/papers/event-sourcing)

## Trip planning (1)

- [Flights to BLR](https://example.net/flights?to=blr)

## Loose tabs (1)

- [Masala dosa, step by step](https://example.com/recipes/masala-dosa)

```

_Tripwires:_ `renderers.test.ts` (“renders headings…”, “escapes markdown structure
injection”).

## 7. Worked checksum example

The §3 arithmetic applied to the §4 example document. Slice the document into its §4 parts
(exact bytes, separators included per the separator law), then:

```
per part:      checksum = crc32Hex(part bytes)          # 8 lowercase hex chars
manifest seal: crc32Hex(ordered "partId:checksum" lines joined with "\n")
```

For the §4 example these lines are (and the unit lane requires them to be):

<!-- covenant-example: seal -->
<!-- prettier-ignore -->
```text
head:990b0dc1
mission:m-alpha:3eddb279
mission:m-beta:937d1558
loose:0:78fe8913
tail:e4ae51f6
manifestChecksum: ffb25ace
```

The final line equals the `manifestChecksum` embedded in the §4 example's manifest — and the
value the journal records as `ExportCompleted.manifestChecksum` for this export (§1).

_Tripwire:_ `src/infrastructure/exporters/export-format-doc.test.ts` re-derives this block
from the renderer.

## 8. Reader covenant (third-party parsers)

The read-forever promise binds Ledge; these rules bind readers:

1. **Refuse loudly on unknown identity:** require `format === "ledge-export"` **and**
   `formatV === 1`; anything else is a different covenant — stop, never guess.
2. **Tolerate additive optional fields:** unknown keys may materialize in minor updates;
   optional §2 fields materialize **absent, never defaulted-in**. Preserve what you do not
   understand rather than dropping it.
3. **Parse the JSON, never the presentations:** §5/§6 are lossy renderings; no importer
   (first- or third-party) may treat them as data sources.
4. **Verify before trusting:** recompute per-part checksums and the manifest seal (§3/§7)
   when streaming; refuse documents whose manifest fails.
5. **`urlCanonHash` is a hint,** never an equality oracle — fnv1a64 is non-cryptographic
   (§2.3); canonicalization semantics belong to the canon ruleset named by `canonRulesV`,
   and exporters carry the field opaquely.
6. **Timestamps are provenance.** `firstSeenAt`/`lastActiveAt` describe the source history;
   an importer must preserve them as metadata and never masquerade imported rows as live
   activity (EES §2.14 importer invariant).

## 9. Versioning covenant

`formatV = 1` is the only produced format. The promise (ADR-045): **every Ledge release reads
format v1 for as long as Ledge exists** — a user's decade-old file stays importable. Any change
to §2–§7 is an ADR, a `formatV` bump, an update to this document, and new tripwires in the same
PR; v1 itself is frozen, never edited in place. The first-party reader (`parser-ledge-export`)
is bound by §8 and by the round-trip law: importing a v1 export reconstructs
the exported truth, timestamps preserved as source metadata (§8.6). **Ship status:** it is
_not_ part of roadmap E5-T05 (that milestone ships the three foreign-format parsers:
OneTab, SessionBuddy, Netscape); the first-party v1 reader is a recorded v1.x gap, tracked
as **[follow-up]** in `docs/adr-notes/e5-importers.md`.

## 10. Tripwire index

| Law                                     | Executable gate                                               |
| --------------------------------------- | ------------------------------------------------------------- |
| Model truth/ordering (§2)               | `src/infrastructure/exporters/model.test.ts`                  |
| Stream verify/regen/fatal (§3)          | `src/infrastructure/exporters/stream.test.ts`                 |
| JSON grammar + embedded manifest (§4)   | `src/infrastructure/exporters/renderers.test.ts`              |
| HTML standalone + escaping (§5)         | `renderers.test.ts`                                           |
| Markdown grammar + escaping (§6)        | `renderers.test.ts`                                           |
| Examples byte-equal renderers (§4–§7)   | `src/infrastructure/exporters/export-format-doc.test.ts`      |
| Journalled seal = JSON manifest (§1/§7) | `ops/tests/unit/application/system-prefs-portability.test.ts` |
| Wired adapter bounds and formats law    | `src/infrastructure/exporters/exporters.adapter.test.ts`      |
