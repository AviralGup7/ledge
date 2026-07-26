// E4 · View store suite — stream DESERIALIZATION only (never projection logic).
// Laws: seed replaces wholesale by view pk; frames apply mechanically per §3.5;
// gaps/regressions apply NOTHING (partial truth is never rendered); unknown views
// report 'reset'; listeners observe seed/delta/gap; dispose clears everything.
import { describe, expect, it } from 'vitest';
import {
  createViewStore,
  resyncCopy,
  viewFrameOf,
  VIEW_PRIMARY_KEY,
  type StoreEvent,
} from '@/surfaces/components/state/view-store.js';

const mission = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  missionId: id,
  name: `Mission ${id}`,
  state: 'parked',
  ...extra,
});

describe('E4 view-store · seed', () => {
  it('seeds rows keyed by the view primary key, skipping pk-less rows', () => {
    const store = createViewStore();
    store.seed('missions', [mission('m1'), mission('m2'), { name: 'pk-less' }], 7);
    expect(store.rows('missions').map((r) => r['missionId'])).toEqual(['m1', 'm2']);
    expect(store.watermarkOf('missions')).toBe(7);
  });

  it('re-seeding replaces wholesale (stale rows vanish)', () => {
    const store = createViewStore();
    store.seed('missions', [mission('m1'), mission('m2')], 1);
    store.seed('missions', [mission('m3')], 2);
    expect(store.rows('missions')).toHaveLength(1);
    expect(store.row('missions', 'm1')).toBeUndefined();
    expect(store.row('missions', 'm3')?.['name']).toBe('Mission m3');
  });

  it('the four frozen views have their catalog pks; unknown views cannot seed rows', () => {
    expect(Object.keys(VIEW_PRIMARY_KEY).sort()).toEqual([
      'missions',
      'recentlyClosed',
      'sessions',
      'tabs',
    ]);
    const store = createViewStore();
    store.seed('not-a-view', [{ notAKey: 1 }], 1);
    expect(store.rows('not-a-view')).toEqual([]);
  });
});

describe('E4 view-store · frames', () => {
  it('upsert/remove/patch apply mechanically by op key', () => {
    const store = createViewStore();
    store.seed('missions', [mission('m1'), mission('m2')], 1);
    const result = store.applyFrame({
      view: 'missions',
      watermark: 2,
      ops: [
        { kind: 'upsert', key: 'm3', record: mission('m3') },
        { kind: 'remove', key: 'm1' },
        { kind: 'patch', key: 'm2', fields: { state: 'archived' } },
      ],
    });
    expect(result).toBe('applied');
    expect(store.row('missions', 'm1')).toBeUndefined();
    expect(store.row('missions', 'm2')?.['state']).toBe('archived');
    expect(store.row('missions', 'm2')?.['name']).toBe('Mission m2'); // patch merges
    expect(store.row('missions', 'm3')).toBeDefined();
    expect(store.watermarkOf('missions')).toBe(2);
  });

  it('patch on a missing key creates a row from fields alone (still mechanical)', () => {
    const store = createViewStore();
    store.applyFrame({
      view: 'missions',
      watermark: 1,
      ops: [{ kind: 'patch', key: 'm9', fields: { missionId: 'm9', name: 'late' } }],
    });
    expect(store.row('missions', 'm9')?.['name']).toBe('late');
  });

  it('same watermark twice is a duplicate (idempotent replay, nothing changes)', () => {
    const store = createViewStore();
    store.seed('missions', [mission('m1')], 3);
    const dup = store.applyFrame({
      view: 'missions',
      watermark: 3,
      ops: [{ kind: 'remove', key: 'm1' }],
    });
    expect(dup).toBe('duplicate');
    expect(store.row('missions', 'm1')).toBeDefined();
  });

  it('a jump forward is a gap: NOTHING is applied (no partial truth)', () => {
    const store = createViewStore();
    store.seed('missions', [mission('m1')], 3);
    const gaps: StoreEvent[] = [];
    store.subscribe((e) => gaps.push(e));
    const result = store.applyFrame({
      view: 'missions',
      watermark: 9,
      ops: [{ kind: 'remove', key: 'm1' }],
    });
    expect(result).toBe('gap');
    expect(store.row('missions', 'm1')).toBeDefined();
    expect(store.watermarkOf('missions')).toBe(3);
    expect(gaps).toEqual([{ kind: 'gap', view: 'missions', expected: 4, got: 9 }]);
  });

  it('a watermark regression is a gap (SW rebuilt truth — rejoin required)', () => {
    const store = createViewStore();
    store.seed('missions', [mission('m1')], 8);
    expect(
      store.applyFrame({ view: 'missions', watermark: 2, ops: [{ kind: 'remove', key: 'm1' }] }),
    ).toBe('gap');
    expect(store.row('missions', 'm1')).toBeDefined();
  });

  it('frames for unknown views report reset and apply nothing', () => {
    const store = createViewStore();
    const result = store.applyFrame({
      view: 'not-a-view',
      watermark: 1,
      ops: [{ kind: 'upsert', key: 'x', record: { missionId: 'x' } }],
    });
    expect(result).toBe('reset');
    expect(store.rows('not-a-view')).toEqual([]);
  });

  it('frames without a prior seed start from the sent watermark (post-rejoin base)', () => {
    const store = createViewStore();
    expect(
      store.applyFrame({
        view: 'missions',
        watermark: 12,
        ops: [{ kind: 'upsert', key: 'm1', record: mission('m1') }],
      }),
    ).toBe('applied');
    expect(store.watermarkOf('missions')).toBe(12);
  });
});

describe('E4 view-store · payload narrowing (transport-shape defense only)', () => {
  it('viewFrameOf accepts well-formed §3.5 frames', () => {
    const frame = viewFrameOf({
      view: 'missions',
      watermark: 4,
      ops: [
        { kind: 'upsert', key: 'm1', record: { missionId: 'm1' } },
        { kind: 'remove', key: 'm0' },
        { kind: 'patch', key: 'm1', fields: { state: 'archived' } },
      ],
    });
    expect(frame?.view).toBe('missions');
    expect(frame?.ops).toHaveLength(3);
  });

  it('viewFrameOf rejects malformed payloads instead of crashing the listener', () => {
    expect(viewFrameOf(undefined)).toBeUndefined();
    expect(viewFrameOf({})).toBeUndefined();
    expect(viewFrameOf({ view: 'missions', watermark: 'x', ops: [] })).toBeUndefined();
    expect(
      viewFrameOf({ view: 'missions', watermark: 1, ops: [{ kind: 'mystery', key: 'k' }] }),
    ).toBeUndefined();
    expect(
      viewFrameOf({ view: 'missions', watermark: 1, ops: [{ kind: 'upsert' }] }),
    ).toBeUndefined();
  });
});

describe('E4 view-store · listeners & lifecycle', () => {
  it('listeners observe seed and delta events; detach silences them', () => {
    const store = createViewStore();
    const seen: StoreEvent[] = [];
    const detach = store.subscribe((e) => seen.push(e));
    store.seed('missions', [mission('m1')], 1);
    store.applyFrame({ view: 'missions', watermark: 2, ops: [{ kind: 'remove', key: 'm1' }] });
    detach();
    store.seed('missions', [], 3);
    expect(seen).toEqual([
      { kind: 'seed', view: 'missions', watermark: 1 },
      { kind: 'delta', view: 'missions', watermark: 2 },
    ]);
  });

  it('dispose clears views, watermarks and listeners (unmount memory law)', () => {
    const store = createViewStore();
    const seen: StoreEvent[] = [];
    store.subscribe((e) => seen.push(e));
    store.seed('missions', [mission('m1')], 5);
    store.dispose();
    expect(store.rows('missions')).toEqual([]);
    expect(store.watermarkOf('missions')).toBeUndefined();
    store.seed('missions', [mission('m2')], 1);
    expect(seen).toHaveLength(1); // only the pre-dispose seed
  });

  it('the resync banner copy comes from the catalog (no surface-local prose)', () => {
    expect(resyncCopy().length).toBeGreaterThan(0);
    expect(resyncCopy()).not.toBe('msg.state.resync'); // resolved, not the key
  });
});
