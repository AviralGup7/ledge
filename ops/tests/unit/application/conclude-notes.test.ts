// E8-T10 · conclude flow + outcome notes (roadmap completion criterion:
// "Archive badge + export includes notes"). D-series: the DTO door (notes
// flow verbatim from row to wire, "concluded = flag + note, not a fourth
// state" §38/§70). E-series: the export covenant ("Mission export includes
// summary and outcome note as readable text" §214) — MD annotation, HTML
// marked paragraph, JSON field, each absent-unless-noted and hostile-safe.
import { describe, expect, it } from 'vitest';
import { missionViewOf } from '@/application/dto/index.js';
import type { MissionViewRow } from '@/application/ports/view-rows.js';
import {
  buildModel,
  type CanonicalExportModel,
  EXPORT_FORMAT,
  EXPORT_FORMAT_V,
} from '@/infrastructure/exporters/model.js';
import { mdParts } from '@/infrastructure/exporters/render-md.js';
import { htmlParts } from '@/infrastructure/exporters/render-html.js';
import { jsonParts } from '@/infrastructure/exporters/render-json.js';
import type { TabStoreRow } from '@/application/ports/view-rows.js';

const WALL = 1_900_300_000_000;
const NOTE = 'Chose Acme — reasons: price, migration path.';

const missionRow = (over?: Partial<MissionViewRow>): MissionViewRow => ({
  missionId: '01HF7YAT001000000000000000',
  name: 'CRM decision',
  namedBy: 'user',
  state: 'archived',
  concluded: true,
  tabIds: [],
  createdAt: WALL - 90_000,
  lastActiveAt: WALL - 5_000,
  ...over,
});

describe('E8-T10 · DTO door (D-series: notes flow, verbatim and optional)', () => {
  it('D1: a noted row maps the note; un-noted rows emit no key (exactOptionalPropertyTypes law)', () => {
    const withNote = missionViewOf(missionRow({ outcomeNote: NOTE }));
    expect(withNote.outcomeNote).toBe(NOTE);
    expect(withNote.concluded).toBe(true);
    const without = missionViewOf(missionRow());
    expect(without.outcomeNote).toBeUndefined();
    expect('outcomeNote' in without).toBe(false);
    const blank = missionViewOf(missionRow({ outcomeNote: '' }));
    expect('outcomeNote' in blank).toBe(false); // whitespace-empty is not a note
  });
});

const tabRow = (): TabStoreRow =>
  ({
    ledgeTabId: '01HF7YCQVR90000R0000000000',
    missionId: '01HF7YAT001000000000000000',
    url: 'https://acme.io/compare',
    urlCanon: 'acme.io/compare',
    canonHash: 'h',
    canonRulesV: 1,
    title: 'Acme vs Beacon',
    domain: 'acme.io',
    state: 'kept',
    firstSeenAt: WALL - 80_000,
    lastActiveAt: WALL - 6_000,
    parkCount: 0,
  }) as TabStoreRow;

const modelWithNote = (note: string | undefined): CanonicalExportModel =>
  buildModel({
    scope: 'all',
    rows: {
      missions: [
        missionRow({
          ...(note !== undefined ? { outcomeNote: note } : {}),
          tabIds: ['01HF7YCQVR90000R0000000000'],
        }),
      ],
      tabs: [tabRow()],
    },
    build: 'test-build',
    canonRulesV: 1,
    now: () => WALL,
  });

const allText = (parts: readonly { text: string }[]): string => parts.map((p) => p.text).join('');

describe('E8-T10 · export covenant (E-series: notes are export material — §214)', () => {
  it('E1: the canonical model carries the note (absent-unless-noted); format pins untouched', () => {
    const withNote = modelWithNote(NOTE);
    expect(withNote.missions[0]?.outcomeNote).toBe(NOTE);
    expect(withNote.format).toBe(EXPORT_FORMAT);
    expect(withNote.formatV).toBe(EXPORT_FORMAT_V); // additive field — no V bump (optional key)
    const without = modelWithNote(undefined);
    expect(without.missions[0]?.outcomeNote).toBeUndefined();
    expect(without.diagnostics.droppedTabRefs).toBe(0);
  });

  it('E2: all three renderers carry the note as READABLE text — MD annotation, HTML paragraph, JSON field', () => {
    const model = modelWithNote(NOTE);
    const md = allText(mdParts(model));
    expect(md).toContain(`**Outcome:** ${NOTE}`);
    const html = allText(htmlParts(model));
    expect(html).toContain(`<strong>Outcome:</strong> ${NOTE}`);
    expect(html).toContain('class="outcome"');
    const json = allText(jsonParts(model));
    expect(json).toContain(`"outcomeNote": "${NOTE}"`);
  });

  it('E3: a hostile note cannot fabricate structure (escaping law rides every renderer)', () => {
    const hostile = modelWithNote('x [y] \\\n<script>alert(1)</script>\r\n\nnext "q" & \'s\'');
    const md = allText(mdParts(hostile));
    expect(md).toContain(
      'x \\[y\\] \\\\ <script>alert(1)</script> \n next "q" & \'s\''.replace(' \n ', ' '),
    );
    expect(md).not.toContain('[y](');
    const html = allText(htmlParts(hostile));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    const json = allText(jsonParts(hostile));
    const parsed = JSON.parse(json) as { missions: { outcomeNote?: string }[] };
    expect(parsed.missions[0]?.outcomeNote).toContain('<script>'); // JSON carries VERBATIM (data, escaped by JSON itself)
  });
});
