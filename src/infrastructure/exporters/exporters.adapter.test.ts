// E5-T03 · Exporters adapter laws — ExporterPort orchestration over fake sources:
// plan shape + scope strings, canonical format order, json-is-the-seal rule,
// formats-empty legality, read-error pass-through (P-25: never minted), artifact
// registry bounds (TTL + cap), and cross-call determinism.
import { describe, expect, it } from 'vitest';
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import type { IdGenerator } from '@/shared-kernel/identity/index.js';
import { platformIds } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import {
  createExportersAdapter,
  EXPORT_ARTIFACT_CAP,
  EXPORT_ARTIFACT_TTL_MS,
} from './exporters.adapter.js';
import type { ExportModelSource } from './model.js';

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
  url: `https://acme.io/${id}`,
  title: `Tab ${id}`,
  domain: 'acme.io',
  state: 'kept',
  firstSeenAt: NOW - 5000,
  lastActiveAt: NOW - 20,
  ...over,
});

const ROWS = {
  missions: [mission('m1', 'Alpha', ['t1'])],
  tabs: [tab('t1', 'm1')],
};

// The real mint (entropy-backed): exportIds must be genuine ULIDs — never fixtures.
const ids: IdGenerator = platformIds;

const sourceOf = (rows: typeof ROWS = ROWS): ExportModelSource => ({
  missions: () => Promise.resolve(ok(rows.missions)),
  tabs: () => Promise.resolve(ok(rows.tabs)),
});

const makeAdapter = (
  overrides: {
    source?: ExportModelSource;
    now?: () => number;
  } = {},
) =>
  createExportersAdapter({
    source: overrides.source ?? sourceOf(),
    ids,
    now: overrides.now ?? (() => NOW),
    build: BUILD,
  });

describe('E5 adapter · plan orchestration', () => {
  it('renders the requested formats in canonical order; json seals the plan', async () => {
    const a = makeAdapter();
    const r = await a.request({ scope: { kind: 'all' }, formats: ['md', 'json', 'html'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.formats).toEqual(['json', 'html', 'md']);
    expect(r.value.scope).toBe('all');
    expect(r.value.manifestChecksum).toMatch(/^[0-9a-f]{8}$/);
    const jsonArtifact = a.fetchArtifact(r.value.exportId)?.artifacts['json'];
    expect(jsonArtifact?.manifest.manifestChecksum).toBe(r.value.manifestChecksum);
    expect(r.value.fetchRef).toEqual({ exportId: r.value.exportId });
  });

  it('scope strings are honest (all | mission:<id>) and mission scope filters the model', async () => {
    const a = makeAdapter();
    const r = await a.request({ scope: { kind: 'mission', missionId: 'm1' }, formats: ['json'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scope).toBe('mission:m1');
    const text = a.fetchArtifact(r.value.exportId)?.artifacts['json']?.text ?? '';
    const parsed = JSON.parse(text) as { scope: unknown; missions: unknown[] };
    expect(parsed.scope).toEqual({ mission: 'm1' });
    expect(parsed.missions).toHaveLength(1);
  });

  it('formats-empty is a domain legality fault, never a render fault', async () => {
    const a = makeAdapter();
    const r = await a.request({ scope: { kind: 'all' }, formats: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_DOMAIN_LEGALITY');
  });

  it('read errors pass through verbatim (P-25: transported, never minted)', async () => {
    const broken: ExportModelSource = {
      missions: () => Promise.resolve(err(ledgeError('E_CORRUPT_STORE', { store: 'missions' }))),
      tabs: () => Promise.resolve(ok([])),
    };
    const a = makeAdapter({ source: broken });
    const r = await a.request({ scope: { kind: 'all' }, formats: ['json'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_CORRUPT_STORE');
  });

  it('same truth ⇒ same manifest checksum across exports (rebuildable artifacts)', async () => {
    const a = makeAdapter();
    const r1 = await a.request({ scope: { kind: 'all' }, formats: ['json'] });
    const r2 = await a.request({ scope: { kind: 'all' }, formats: ['json'] });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.manifestChecksum).toBe(r2.value.manifestChecksum);
    expect(r1.value.exportId).not.toBe(r2.value.exportId);
  });

  it('registry honors TTL (expired artifacts disappear) and the cap evicts oldest', async () => {
    let clock = NOW;
    const a = makeAdapter({ now: () => clock });
    const idsSeen: string[] = [];
    for (let i = 0; i < EXPORT_ARTIFACT_CAP + 2; i += 1) {
      const r = await a.request({ scope: { kind: 'all' }, formats: ['json'] });
      if (r.ok) idsSeen.push(r.value.exportId);
    }
    expect(idsSeen).toHaveLength(EXPORT_ARTIFACT_CAP + 2);
    // Cap law: the two oldest are evicted, the newest EXPORT_ARTIFACT_CAP survive.
    expect(a.fetchArtifact(idsSeen[0] ?? '')).toBeUndefined();
    expect(a.fetchArtifact(idsSeen[1] ?? '')).toBeUndefined();
    expect(a.fetchArtifact(idsSeen[EXPORT_ARTIFACT_CAP + 1] ?? '')?.modelMeta.missions).toBe(1);
    // TTL law: past the horizon, even a live id is gone.
    clock = NOW + EXPORT_ARTIFACT_TTL_MS + 1;
    expect(a.fetchArtifact(idsSeen[EXPORT_ARTIFACT_CAP + 1] ?? '')).toBeUndefined();
  });
});
