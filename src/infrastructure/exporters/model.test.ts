// E5-T03 · Canonical model laws — projection-snapshot sourcing, deterministic
// ordering (same truth ⇒ same bytes), trash exclusion, covered/loose partition,
// and the dropped-tab disclosure (no-silent-drop law).
import { describe, expect, it } from 'vitest';
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import { buildModel, EXPORT_FORMAT, EXPORT_FORMAT_V } from './model.js';

const NOW = 1_800_000_000_000;
const BUILD = 'build-test-deadbeef';

const mission = (
  id: string,
  name: string,
  tabIds: readonly string[],
  over = {},
): MissionViewRow => ({
  missionId: id,
  name,
  namedBy: 'user',
  state: 'parked',
  concluded: false,
  tabIds,
  createdAt: NOW - 1000,
  lastActiveAt: NOW - 10,
  ...over,
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

const build = (
  missions: readonly MissionViewRow[],
  tabs: readonly TabStoreRow[],
  scope: 'all' | { mission: string } = 'all',
) => buildModel({ scope, rows: { missions, tabs }, build: BUILD, canonRulesV: 1, now: () => NOW });

describe('E5 model · projection-snapshot sourcing', () => {
  it('provenance stamps ride the model (format, formatV, build, canonRulesV, generatedAt)', () => {
    const model = build([], []);
    expect(model.format).toBe(EXPORT_FORMAT);
    expect(model.formatV).toBe(EXPORT_FORMAT_V);
    expect(model.app).toEqual({ name: 'Ledge', build: BUILD });
    expect(model.canonRulesV).toBe(1);
    expect(model.generatedAt).toBe(NOW);
    expect(model.scope).toBe('all');
    expect(model.missions).toEqual([]);
    expect(model.looseTabs).toEqual([]);
    expect(model.diagnostics).toEqual({ droppedTabRefs: 0 });
  });

  it('missions resolve their tabs in mission declaration order; loose tabs partition out', () => {
    const m1 = mission('m1', 'Alpha', ['t2', 't1']);
    const model = build([m1], [tab('t1', 'm1'), tab('t2', 'm1'), tab('t9', '', { state: 'live' })]);
    expect(model.missions).toHaveLength(1);
    expect(model.missions[0]?.tabs.map((t) => t.url)).toEqual([
      'https://acme.io/t2',
      'https://acme.io/t1',
    ]);
    expect(model.looseTabs.map((t) => t.url)).toEqual(['https://acme.io/t9']);
  });

  it('trash never crosses the front door: trashed missions AND tabs excluded', () => {
    const m1 = mission('m1', 'Alpha', ['t1', 't2'], { state: 'trash' });
    const m2 = mission('m2', 'Beta', ['t3']);
    const model = build(
      [m1, m2],
      [
        tab('t1', 'm1'),
        tab('t2', 'm1', { state: 'trash' }),
        tab('t3', 'm2'),
        tab('t4', '', { state: 'trash' }),
      ],
    );
    expect(model.missions.map((m) => m.missionId)).toEqual(['m2']);
    expect(model.missions[0]?.tabs.map((t) => t.title)).toEqual(['Tab t3']);
    // m1 is trashed ⇒ its declaration list is never walked: no drops counted.
    // t1 (kept but mission unresolvable) honestly surfaces loose; t2/t4 (trash)
    // have no export surface at all.
    expect(model.diagnostics.droppedTabRefs).toBe(0);
    expect(model.looseTabs.map((t) => t.title)).toEqual(['Tab t1']);
  });

  it('a mission ref without a tabs row is dropped AND disclosed (never fabricated)', () => {
    const m1 = mission('m1', 'Alpha', ['t1', 'ghost']);
    const model = build([m1], [tab('t1', 'm1')]);
    expect(model.missions[0]?.tabs).toHaveLength(1);
    expect(model.diagnostics.droppedTabRefs).toBe(1);
  });

  it('scope mission filters honestly; loose tabs of other missions stay loose', () => {
    const m1 = mission('m1', 'Alpha', ['t1']);
    const m2 = mission('m2', 'Beta', ['t2']);
    const model = build([m1, m2], [tab('t1', 'm1'), tab('t2', 'm2')], { mission: 'm2' });
    expect(model.scope).toEqual({ mission: 'm2' });
    expect(model.missions.map((m) => m.missionId)).toEqual(['m2']);
    // m1 tabs are not covered by the scoped export ⇒ honest loose surface.
    expect(model.looseTabs.map((t) => t.title)).toEqual(['Tab t1']);
  });

  it('ordering is deterministic: input shuffles produce byte-identical models', () => {
    const mk = (): [MissionViewRow[], TabStoreRow[]] => [
      [
        mission('m2', 'Beta', ['t2'], { createdAt: NOW - 900 }),
        mission('m1', 'Alpha', ['t1'], { createdAt: NOW - 1000 }),
      ],
      [
        tab('t2', 'm2', { firstSeenAt: NOW - 4000 }),
        tab('t1', 'm1', { firstSeenAt: NOW - 5000 }),
        tab('t3', '', { state: 'live', firstSeenAt: NOW - 3000 }),
      ],
    ];
    const [ma, ta] = mk();
    const a = build(ma, ta.reverse());
    const b = build([...ma].reverse(), [...ta].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.missions.map((m) => m.missionId)).toEqual(['m1', 'm2']);
  });

  it('additive optional fields ride through when present, absent when not', () => {
    const model = build(
      [mission('m1', 'A', ['t1'])],
      [tab('t1', 'm1', { urlCanonHash: 'hash-1' })],
    );
    expect(model.missions[0]?.tabs[0]?.urlCanonHash).toBe('hash-1');
    expect(model.missions[0]?.tabs[0]?.firstSeenAt).toBe(NOW - 5000);
    const sparse = build([mission('m1', 'A', ['t2'])], [tab('t2', 'm1')]);
    expect('urlCanonHash' in (sparse.missions[0]?.tabs[0] ?? {})).toBe(false);
  });
});
