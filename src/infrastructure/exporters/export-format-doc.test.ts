// E5-T04 · The covenant's examples are renderer-proven (roadmap E5-T04 AC:
// "examples validated"). Every marked example block in docs/export-format-v1.md
// must BYTE-EQUAL the shipped renderers' output for the fixed covenant model
// below; drift fails the unit lane loud. Marker grammar (the only coupling the
// doc and this test share):
//
//   <!-- covenant-example: <key> -->
//   <!-- prettier-ignore -->
//   ```…
//   <artifact bytes, exactly as rendered>
//   ```
//
// `prettier-ignore` guards the fence's next node: prettier's embedded-language
// formatting must never rewrite covenant bytes. The trailing-newline law shows
// as an empty final line inside each fence (artifacts end with "\n"; the fence
// close rides the next line).
//
// Intentional regeneration — a renderer change and its doc update land in the
// SAME PR (covenant §9 discipline), and this regenerates the blocks:
//   COVENANT_EXAMPLES_UPDATE=1 pnpm test:unit -- export-format-doc
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import { buildModel, type CanonicalExportModel } from './model.js';
import { htmlParts } from './render-html.js';
import { jsonParts } from './render-json.js';
import { mdParts } from './render-md.js';
import { assembleVerified, streamParts, type ExportArtifact, type RawPart } from './stream.js';

// ---- The covenant model (fixed for every formatV=1 example) ------------------
// The fixture exercises the grammar in one small document: two missions in
// deterministic order, one tab carrying the optional provenance fields, one
// dropped mission→tab ref (diagnostics arithmetic surface), one loose tab.
const GENERATED_AT = 1_785_024_000_000; // 2026-07-26T00:00:00.000Z
const BUILD = 'a94f3c21807bc6d5'; // contract-hash-shaped build id (16 hex)
const CANON_RULES_V = 1;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const COVENANT_MISSIONS: readonly MissionViewRow[] = [
  {
    missionId: 'm-alpha',
    name: 'Reading list',
    namedBy: 'user',
    state: 'parked',
    concluded: false,
    tabIds: ['t-01', 't-02'],
    createdAt: GENERATED_AT - 2 * DAY_MS,
    lastActiveAt: GENERATED_AT - 3 * HOUR_MS,
  },
  {
    missionId: 'm-beta',
    name: 'Trip planning',
    namedBy: 'user',
    state: 'live',
    concluded: false,
    tabIds: ['t-03', 't-missing'],
    createdAt: GENERATED_AT - DAY_MS,
    lastActiveAt: GENERATED_AT - HOUR_MS,
  },
];

const COVENANT_TABS: readonly TabStoreRow[] = [
  {
    ledgeTabId: 't-01',
    missionId: 'm-alpha',
    url: 'https://example.com/articles/tab-suspension',
    title: 'The case for tab suspension',
    domain: 'example.com',
    state: 'kept',
    urlCanonHash: 'a1b2c3d4e5f60718',
    firstSeenAt: GENERATED_AT - 2 * DAY_MS,
    lastActiveAt: GENERATED_AT - 3 * HOUR_MS,
  },
  {
    ledgeTabId: 't-02',
    missionId: 'm-alpha',
    url: 'https://example.org/papers/event-sourcing',
    title: 'Event sourcing field notes',
    domain: 'example.org',
    state: 'live',
    firstSeenAt: GENERATED_AT - 2 * DAY_MS + HOUR_MS,
    lastActiveAt: GENERATED_AT - 2 * HOUR_MS,
  },
  {
    ledgeTabId: 't-03',
    missionId: 'm-beta',
    url: 'https://example.net/flights?to=blr',
    title: 'Flights to BLR',
    domain: 'example.net',
    state: 'kept',
    firstSeenAt: GENERATED_AT - 20 * HOUR_MS,
    lastActiveAt: GENERATED_AT - HOUR_MS,
  },
  {
    ledgeTabId: 't-loose',
    missionId: '',
    url: 'https://example.com/recipes/masala-dosa',
    title: 'Masala dosa, step by step',
    domain: 'example.com',
    state: 'live',
    firstSeenAt: GENERATED_AT - 5 * HOUR_MS,
    lastActiveAt: GENERATED_AT - 30 * 60_000,
  },
];

const covenantModel = (): CanonicalExportModel =>
  buildModel({
    scope: 'all',
    rows: { missions: COVENANT_MISSIONS, tabs: COVENANT_TABS },
    build: BUILD,
    canonRulesV: CANON_RULES_V,
    now: () => GENERATED_AT,
  });

const renderFormat = async (parts: readonly RawPart[], format: string): Promise<ExportArtifact> => {
  const assembled = await assembleVerified(format, () => streamParts(parts));
  if (!assembled.ok) throw new Error(`render ${format} failed: ${assembled.error.code}`);
  return assembled.value;
};

/** Every example key the covenant carries ⇔ the artifacts this produces (census
 *  runs both ways — a renamed marker or a missing block fails loud). */
const produceExamples = async (): Promise<ReadonlyMap<string, string>> => {
  const model = covenantModel();
  const json = await renderFormat(jsonParts(model), 'json');
  const html = await renderFormat(htmlParts(model), 'html');
  const md = await renderFormat(mdParts(model), 'md');
  const seal = [
    ...json.manifest.parts.map((p) => `${p.partId}:${p.checksum}`),
    `manifestChecksum: ${json.manifest.manifestChecksum}`,
  ].join('\n');
  return new Map([
    ['json', json.text],
    ['html', html.text],
    ['md', md.text],
    ['seal', seal],
  ]);
};

// ---- Marked-block IO ----------------------------------------------------------
const DOC_PATH = fileURLToPath(new URL('../../../docs/export-format-v1.md', import.meta.url));
const UPDATE = process.env['COVENANT_EXAMPLES_UPDATE'] === '1';

/** Fresh regex per use (global-regex lastIndex is shared state). Groups:
 *  1 = marker + ignore + opening fence, 2 = key, 3 = block content, 4 = close. */
const markerRe = (): RegExp =>
  /(<!-- covenant-example: (\w+) -->\n<!-- prettier-ignore -->\n```[^\n]*\n)([\s\S]*?)(\n```)/g;

const extractExamples = (doc: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  for (const match of doc.matchAll(markerRe())) {
    const key = match[2] ?? '';
    found.set(key, match[3] ?? '');
  }
  return found;
};

const swapExamples = (doc: string, produced: ReadonlyMap<string, string>): string =>
  doc.replace(
    markerRe(),
    (_whole, head: string, key: string, _content: string, tail: string) =>
      `${head}${produced.get(key) ?? ''}${tail}`,
  );

describe('E5-T04 export-format covenant · examples validated against shipped renderers', () => {
  it('every marked block byte-equals the renderers’ output for the covenant model', async () => {
    const produced = await produceExamples();
    if (UPDATE) {
      writeFileSync(DOC_PATH, swapExamples(readFileSync(DOC_PATH, 'utf8'), produced), 'utf8');
    }
    const marked = extractExamples(readFileSync(DOC_PATH, 'utf8'));
    expect([...marked.keys()].sort()).toEqual([...produced.keys()].sort());
    for (const [key, bytes] of produced) {
      expect(marked.get(key), `covenant example "${key}" drifted from the ${key} renderer`).toBe(
        bytes,
      );
    }
  });
});
