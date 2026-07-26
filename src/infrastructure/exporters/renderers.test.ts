// E5-T03 · Renderer laws — json (grammar validity, embedded manifest ≡ assembled
// manifest, determinism, round-trip fidelity), html (standalone law: self-contained,
// escaping), md (notes grammar, escaping). Assertion style: parse and compare
// structurally — goldens over FORMAT-COVENANT fields, not brittle full-byte blobs.
import { describe, expect, it } from 'vitest';
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import { buildModel, type CanonicalExportModel } from './model.js';
import { htmlParts } from './render-html.js';
import { jsonParts, LOOSE_BATCH } from './render-json.js';
import { mdParts } from './render-md.js';
import { assembleVerified, streamParts, type RenderManifest } from './stream.js';

const NOW = 1_800_000_000_000;
const BUILD = 'build-test-deadbeef';

const mission = (id: string, name: string, tabIds: readonly string[]): MissionViewRow => ({
  missionId: id,
  name,
  namedBy: 'user',
  state: 'parked',
  concluded: false,
  tabIds,
  createdAt: NOW - 1000,
  lastActiveAt: NOW - 10,
});

const tab = (id: string, missionId: string, over = {}): TabStoreRow => ({
  ledgeTabId: id,
  missionId,
  url: `https://acme.io/${id}?q=1`,
  title: `Tab ${id}`,
  domain: 'acme.io',
  state: 'kept',
  firstSeenAt: NOW - 5000,
  lastActiveAt: NOW - 20,
  ...over,
});

const modelOf = (
  missions: readonly MissionViewRow[],
  tabs: readonly TabStoreRow[],
): CanonicalExportModel =>
  buildModel({
    scope: 'all',
    rows: { missions, tabs },
    build: BUILD,
    canonRulesV: 1,
    now: () => NOW,
  });

const SAMPLE = (): CanonicalExportModel =>
  modelOf(
    [mission('m1', 'Alpha', ['t1', 't2']), mission('m2', 'Beta', ['t3'])],
    [tab('t1', 'm1'), tab('t2', 'm1'), tab('t3', 'm2'), tab('t9', '', { state: 'live' })],
  );

const render = async (
  model: CanonicalExportModel,
  parts: (m: CanonicalExportModel) => ReturnType<typeof jsonParts>,
  format: string,
) => {
  const assembled = await assembleVerified(format, () => streamParts(parts(model)));
  if (!assembled.ok) throw new Error(`render ${format} failed: ${assembled.error.code}`);
  return assembled.value;
};

describe('E5 render-json · the covenant grammar', () => {
  it('emits a single valid JSON document with the provenance block', async () => {
    const artifact = await render(SAMPLE(), jsonParts, 'json');
    const parsed = JSON.parse(artifact.text) as Record<string, unknown>;
    expect(parsed['format']).toBe('ledge-export');
    expect(parsed['formatV']).toBe(1);
    expect(parsed['app']).toEqual({ name: 'Ledge', build: BUILD });
    expect(parsed['canonRulesV']).toBe(1);
    expect(parsed['generatedAt']).toBe(NOW);
    expect(parsed['scope']).toBe('all');
  });

  it('round-trips the canonical model (missions, tabs, loose, diagnostics)', async () => {
    const model = SAMPLE();
    const artifact = await render(model, jsonParts, 'json');
    const parsed = JSON.parse(artifact.text) as {
      missions: unknown;
      looseTabs: unknown;
      diagnostics: unknown;
    };
    expect(parsed.missions).toEqual(JSON.parse(JSON.stringify(model.missions)));
    expect(parsed.looseTabs).toEqual(JSON.parse(JSON.stringify(model.looseTabs)));
    expect(parsed.diagnostics).toEqual(model.diagnostics);
  });

  it('the embedded manifest ≡ the assembler-sealed manifest (sealer consistency)', async () => {
    const artifact = await render(SAMPLE(), jsonParts, 'json');
    const parsed = JSON.parse(artifact.text) as { manifest: RenderManifest };
    expect(parsed.manifest.manifestChecksum).toBe(artifact.manifest.manifestChecksum);
    expect(parsed.manifest.parts).toEqual(artifact.manifest.parts);
    expect(parsed.manifest.partCount).toBe(artifact.manifest.partCount);
    // Per-part checksum law: every sealed part names its chunk crc.
    for (const part of parsed.manifest.parts) {
      expect(part.partId.length).toBeGreaterThan(0);
      expect(part.checksum).toMatch(/^[0-9a-f]{8}$/);
      expect(part.bytes).toBeGreaterThan(0);
    }
  });

  it('is byte-deterministic (same model ⇒ same checksums — rebuildable artifact)', async () => {
    const a = await render(SAMPLE(), jsonParts, 'json');
    const b = await render(SAMPLE(), jsonParts, 'json');
    expect(a.text).toBe(b.text);
    expect(a.manifest.manifestChecksum).toBe(b.manifest.manifestChecksum);
  });

  it('hostile strings ride JSON safely (round-trip equality, no grammar break)', async () => {
    const evil = 'x"\\\n</script>{},{"missions":[';
    const model = modelOf([mission('m1', evil, ['t1'])], [tab('t1', 'm1', { title: evil })]);
    const artifact = await render(model, jsonParts, 'json');
    const parsed = JSON.parse(artifact.text) as {
      missions: { name: string; tabs: { title: string }[] }[];
    };
    expect(parsed.missions[0]?.name).toBe(evil);
    expect(parsed.missions[0]?.tabs[0]?.title).toBe(evil);
  });

  it('streams loose tabs in LOOSE_BATCH parts (partId arithmetic)', async () => {
    const looseRows = Array.from({ length: LOOSE_BATCH + 1 }, (_, i) =>
      tab(`l${i}`, '', { state: 'live' }),
    );
    const model = modelOf([], looseRows);
    const parts = jsonParts(model);
    expect(parts.map((p) => p.partId)).toEqual(['head', 'loose:0', 'loose:1', 'tail', 'manifest']);
    const artifact = await render(model, jsonParts, 'json');
    const parsed = JSON.parse(artifact.text) as { looseTabs: unknown[] };
    expect(parsed.looseTabs).toHaveLength(LOOSE_BATCH + 1);
  });

  it('empty model stays a valid document (grammar edge: both arrays empty)', async () => {
    const artifact = await render(modelOf([], []), jsonParts, 'json');
    const parsed = JSON.parse(artifact.text) as Record<string, unknown>;
    expect(parsed['missions']).toEqual([]);
    expect(parsed['looseTabs']).toEqual([]);
  });
});

describe('E5 render-html · the standalone law', () => {
  it('is self-contained: no scripts, no external assets of any kind', async () => {
    const artifact = await render(SAMPLE(), htmlParts, 'html');
    expect(artifact.text).toContain('<!doctype html>');
    expect(artifact.text).toContain('<style>');
    expect(artifact.text.toLowerCase()).not.toContain('<script');
    expect(artifact.text.toLowerCase()).not.toContain('src=');
    expect(artifact.text.toLowerCase()).not.toContain('@import');
    expect(artifact.text).not.toContain('url(');
    // Every URL the document references is a DATA anchor (user-invoked link).
    for (const match of artifact.text.matchAll(/(https?:\/\/[^"'\s]+)/g)) {
      expect(match[0]).toContain('acme.io');
    }
    // The loose shelf renders with its count when the model has loose tabs
    // (the count rides a span — assert the grammar pieces, never a glued string).
    expect(artifact.text).toContain('Loose tabs <span class="count">(1)</span>');
    expect(artifact.text).toContain('href="https://acme.io/t9?q=1"');
  });

  it('renders missions, counts, and links; escapes hostile titles', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const model = modelOf([mission('m1', evil, ['t1'])], [tab('t1', 'm1', { title: evil })]);
    const artifact = await render(model, htmlParts, 'html');
    expect(artifact.text).not.toContain(evil);
    expect(artifact.text).toContain('&lt;img');
    expect(artifact.text).toContain('<h2>');
    expect(artifact.text).toContain('(1)'); // one tab in the mission
    expect(artifact.text).toContain('href="https://acme.io/t1?q=1"');
  });
});

describe('E5 render-md · notes grammar', () => {
  it('renders headings, provenance, and link lists', async () => {
    const artifact = await render(SAMPLE(), mdParts, 'md');
    expect(artifact.text).toContain('# Ledge export');
    expect(artifact.text).toContain('format ledge-export v1');
    expect(artifact.text).toContain('## Alpha (2)');
    expect(artifact.text).toContain('- [Tab t1](https://acme.io/t1?q=1)');
    expect(artifact.text).toContain('## Loose tabs (1)');
  });

  it('escapes markdown structure injection in titles', async () => {
    const evil = 'a](https://evil.io) [click\n\n## pwnd';
    const model = modelOf([mission('m1', 'M', ['t1'])], [tab('t1', 'm1', { title: evil })]);
    const artifact = await render(model, mdParts, 'md');
    // The law is NEUTRALIZATION, not absence: escaped brackets break the link
    // grammar and whitespace-collapse denies any injected heading its line start.
    expect(artifact.text).not.toMatch(/^## pwnd/m);
    expect(artifact.text).not.toMatch(/^\s*\[click\]/m);
    expect(artifact.text).toContain('\\](https://evil.io)'); // the escape actually fired
    expect(artifact.text).toContain('\\[');
    // …and the surviving link is the tab's own, exactly one list item.
    expect(artifact.text).toContain('](https://acme.io/t1?q=1)');
    expect(
      artifact.text
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('- ')).length,
    ).toBe(1);
  });
});
