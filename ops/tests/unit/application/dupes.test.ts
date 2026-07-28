// E8-T07 · dupe actions law (roadmap completion criterion: "No silent closing
// (spec) — action tests"). G-series: grouping/keep-pick determinism. A-series:
// the application action — parks EXACTLY the older copies on tap (and NOTHING
// otherwise), act-on-now legality, convergent idempotence, dismiss memory.
// C-series: the v1.1 reserve wire (frozen shape, unavailable-name today).
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import { createDupesService, DUPE_IGNORE_PREFIX } from '@/application/usecases/dupes.js';
import type { DupesParkSeam } from '@/application/usecases/dupes.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import { findDupeGroups, type DupeGroupInput } from '@/domain/lifecycle/index.js';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import { computeContractHash, validateMessage } from '@/application/contracts/index.js';
import { MESSAGE_REGISTRY } from '@/application/contracts/message.registry.js';
import type { MessageEnvelope } from '@/application/contracts/envelope.js';
import { ok, err, ledgeError } from '@/shared-kernel/result/index.js';
import type { Id } from '@/shared-kernel/identity/index.js';

const WALL = 1_786_600_000_000;

const tab = (over: Partial<DupeGroupInput> & { readonly url: string }): DupeGroupInput => ({
  ledgeTabId: over.ledgeTabId ?? testId(1),
  browserTabId: over.browserTabId ?? 101,
  title: over.title ?? 'a page',
  url: over.url,
  domain: over.domain ?? 'example.com',
  lastActiveAt: over.lastActiveAt ?? WALL,
});

describe('E8-T07 · grouping law (G-series: marks, deterministically)', () => {
  it('G1: same-canon URLs group; keep is the most-recent; candidates older-first; domain/title from keep', () => {
    const older = tab({
      ledgeTabId: testId(11),
      browserTabId: 11,
      url: 'https://example.com/a',
      title: 'first copy',
      lastActiveAt: WALL - 3_000,
    });
    const newest = tab({
      ledgeTabId: testId(12),
      browserTabId: 12,
      url: 'https://example.com/a',
      title: 'fresh copy',
      lastActiveAt: WALL,
    });
    const middle = tab({
      ledgeTabId: testId(13),
      browserTabId: 13,
      url: 'https://example.com/a',
      title: 'middle copy',
      lastActiveAt: WALL - 1_000,
    });
    const loner = tab({
      ledgeTabId: testId(14),
      browserTabId: 14,
      url: 'https://other.example/x',
      lastActiveAt: WALL - 2_000,
    });
    const groups = findDupeGroups([older, newest, middle, loner]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    if (g === undefined) throw new Error('group missing');
    expect(g.keep.ledgeTabId).toBe(newest.ledgeTabId);
    expect(g.title).toBe('fresh copy');
    expect(g.parkCandidates.map((t) => t.browserTabId)).toEqual([13, 11]); // older-first
  });

  it('G2: canon v1 folds host-casing, bare-root slash and denied tracking params — and NOTHING more', () => {
    const bare = tab({
      ledgeTabId: testId(21),
      browserTabId: 21,
      url: 'https://EXAMPLE.com/?utm_source=nl',
    });
    const canon = tab({ ledgeTabId: testId(22), browserTabId: 22, url: 'https://example.com' });
    const fragged = tab({
      ledgeTabId: testId(23),
      browserTabId: 23,
      url: 'https://example.com/#frag',
    });
    const slashed = tab({
      ledgeTabId: testId(24),
      browserTabId: 24,
      url: 'https://example.com/a/',
    });
    const unslashed = tab({
      ledgeTabId: testId(25),
      browserTabId: 25,
      url: 'https://example.com/a',
    });
    const slashedB = tab({
      ledgeTabId: testId(26),
      browserTabId: 26,
      url: 'https://example.com/a/',
    });
    const groups = findDupeGroups([bare, canon, fragged, slashed, unslashed, slashedB]);
    const pairs = groups
      .map((g) => [g.keep.browserTabId, ...g.parkCandidates.map((t) => t.browserTabId)].sort())
      .map((members) => members.join(','))
      .sort();
    // {bare,canon} group: case folded, bare-root slash dropped, utm_* denied.
    // {slashed,slashedB} group: identical sub-path-slash URLs group normally.
    expect(pairs).toEqual(['21,22', '24,26']);
    // Canon folds the BARE path only: '/a/' vs '/a' stay apart (conservative law), and
    // '#frag' is preserved evidence — the fragment copy and the unslashed copy join NOTHING.
    const flat = pairs.flatMap((p) => p.split(','));
    expect(flat).not.toContain('23');
    expect(flat).not.toContain('25');
  });

  it('G3: ungroupable/absent/ignored evidence is silent; order + cap are deterministic', () => {
    const mk = (n: number, url: string): DupeGroupInput[] =>
      Array.from({ length: n }, (_, i) =>
        tab({
          ledgeTabId: `${String(i).padStart(22, '0')}AA${n}`,
          browserTabId: 300 + n * 10 + i,
          url,
          lastActiveAt: WALL + i,
        }),
      );
    const tabs = [
      ...mk(4, 'https://four.example/x'),
      ...mk(3, 'https://three.example/x'),
      ...mk(2, 'https://two.example/x'),
      tab({ ledgeTabId: '0000000000000000000000000A', browserTabId: 399, url: '' }), // skipped
    ];
    const groups = findDupeGroups(tabs);
    expect(groups.map((g) => g.parkCandidates.length + 1)).toEqual([4, 3, 2]); // relief order
    // Ignored hash disappears from the strip entirely (memory, not deletion).
    const fourHash = groups[0]?.canonHash ?? '';
    const filtered = findDupeGroups(tabs, new Set([fourHash]));
    expect(filtered.map((g) => g.canonHash)).not.toContain(fourHash);
    expect(filtered).toHaveLength(2);
    // Cap law: at most 5 rows on the strip.
    const many = Array.from({ length: 7 }, (_, g) => mk(2, `https://g${g}.example/x`)).flat();
    expect(findDupeGroups(many)).toHaveLength(5);
  });
});

// ── application harness (prefs-style edge; rows seeded straight into stores) ──
const ctx: UseCtx = {
  cid: 'cid-dupes',
  token: { cid: 'cid-dupes', isCancelled: () => false, throwIfCancelled: () => undefined },
  progress: { emit: () => undefined, readonly: () => undefined } as unknown as UseCtx['progress'],
  notifyPending: () => undefined,
};

interface AppHarness {
  readonly engine: StorageEnginePort;
  readonly service: ReturnType<typeof createDupesService>;
  readonly parkCalls: readonly number[];
  readonly events: () => Promise<readonly EventEnvelope[]>;
  readonly seedTab: (t: DupeGroupInput & { readonly state?: string }) => Promise<void>;
  readonly putSetting: (key: string, value: boolean) => Promise<void>;
}

const makeApp = async (parkScript?: DupesParkSeam['parkTab']): Promise<AppHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  const ids = createIdGenerator({
    now: () => WALL,
    randomBytes: (n: number) => new Uint8Array(n).fill(3),
  });
  let nowValue = WALL;
  const now = (): number => (nowValue += 1);
  const appender = createStreamAppender({ journal, projections, deviceId: DEV_A, ids, now });
  const deps = {
    engine,
    journal,
    projections,
    ids,
    deviceId: DEV_A,
    now,
  } as unknown as ServiceDeps;
  const edge: ServiceEdge = { deps, appender };
  const calls: number[] = [];
  const seam: DupesParkSeam = {
    parkTab:
      parkScript ??
      ((input) => {
        calls.push(input.browserTabId);
        return Promise.resolve(ok({ kept: `tab-${input.browserTabId}` }));
      }),
  };
  const h: AppHarness = {
    engine,
    service: createDupesService(edge, seam),
    parkCalls: calls,
    seedTab: async (t) => {
      const r = await engine.txn(['tabs'], 'readwrite', async (tx) => {
        await tx.table('tabs').put({
          ledgeTabId: t.ledgeTabId,
          missionId: '',
          url: t.url,
          title: t.title,
          domain: t.domain,
          state: t.state ?? 'live',
          firstSeenAt: t.lastActiveAt,
          lastActiveAt: t.lastActiveAt,
          browserTabId: t.browserTabId,
        });
      });
      if (!r.ok) throw new Error('seed failed');
    },
    putSetting: async (key, value) => {
      const r = await engine.txn(['settings'], 'readwrite', async (tx) => {
        await tx.table('settings').put({ key, value, schemaV: 1, updatedAt: WALL });
      });
      if (!r.ok) throw new Error('setting failed');
    },
    events: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error('readRange failed');
      return r.value.events.map((e) => e.envelope);
    },
  };
  return h;
};

const DUPE_URL = 'https://docs.example/spec';
const dupeRows = (): readonly (DupeGroupInput & { state?: string })[] => [
  tab({
    ledgeTabId: testId(41),
    browserTabId: 41,
    url: DUPE_URL,
    title: 'old spec',
    lastActiveAt: WALL - 2_000,
  }),
  tab({
    ledgeTabId: testId(42),
    browserTabId: 42,
    url: DUPE_URL,
    title: 'fresh spec',
    lastActiveAt: WALL,
  }),
  tab({
    ledgeTabId: testId(43),
    browserTabId: 43,
    url: DUPE_URL,
    title: 'mid spec',
    lastActiveAt: WALL - 1_000,
  }),
  tab({
    ledgeTabId: testId(44),
    browserTabId: 44,
    url: 'https://other.example/y',
    lastActiveAt: WALL - 500,
  }),
];

describe('E8-T07 · action law (A-series — no silent closing, ever)', () => {
  it('A1: list answers groups from live rows; ignored hashes stay dismissed', async () => {
    const h = await makeApp();
    for (const row of dupeRows()) await h.seedTab(row);
    const listed = await h.service.listDupeGroups(ctx);
    if (!listed.ok) throw new Error('list failed');
    expect(listed.value).toHaveLength(1);
    const g = listed.value[0];
    expect(g?.keep.browserTabId).toBe(42);
    expect(g?.parkCandidates.map((t) => t.browserTabId)).toEqual([43, 41]);
    expect(h.parkCalls).toHaveLength(0); // READING never acts
    // Dismiss the group ⇒ the strip stays honest.
    const hash = g?.canonHash ?? '';
    await h.putSetting(`${DUPE_IGNORE_PREFIX}${hash}`, true);
    const again = await h.service.listDupeGroups(ctx);
    if (!again.ok) throw new Error('list failed');
    expect(again.value).toHaveLength(0);
  });

  it('A2 · CRITERION: one tap parks EXACTLY the older copies, keeps the fresh tab, reports the count', async () => {
    const h = await makeApp();
    for (const row of dupeRows()) await h.seedTab(row);
    const listed = await h.service.listDupeGroups(ctx);
    if (!listed.ok) throw new Error('list failed');
    const g = listed.value[0];
    if (g === undefined) throw new Error('group missing');
    expect(h.parkCalls).toHaveLength(0); // nothing parked without the tap
    const done = await h.service.parkDupeGroup(
      { canonHash: g.canonHash, keepBrowserTabId: 42 },
      ctx,
    );
    if (!done.ok) throw new Error(`park failed: ${done.error.code}`);
    expect(done.value.parkedCount).toBe(2);
    expect(h.parkCalls).toEqual([43, 41]); // exactly the candidates, older-first
    expect(h.parkCalls).not.toContain(42); // the keep tab is exempt
    expect(h.parkCalls).not.toContain(44); // unrelated tabs untouched
  });

  it('A3: a dissolved group is a calm legality answer, never a stale write', async () => {
    const h = await makeApp();
    const gone = await h.service.parkDupeGroup(
      { canonHash: 'no-such-hash', keepBrowserTabId: 42 },
      ctx,
    );
    expect(gone.ok).toBe(false);
    if (!gone.ok) {
      expect(gone.error.code).toBe('E_DOMAIN_LEGALITY');
      expect(gone.error.details?.['reason']).toBe('group-gone');
    }
    expect(h.parkCalls).toHaveLength(0);
  });

  it('A4: a moved keep pick refuses rather than parking around a stale choice', async () => {
    const h = await makeApp();
    for (const row of dupeRows()) await h.seedTab(row);
    const listed = await h.service.listDupeGroups(ctx);
    if (!listed.ok) throw new Error('list failed');
    const g = listed.value[0];
    if (g === undefined) throw new Error('group missing');
    const stale = await h.service.parkDupeGroup(
      { canonHash: g.canonHash, keepBrowserTabId: 41 },
      ctx,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.details?.['reason']).toBe('keep-moved');
    expect(h.parkCalls).toHaveLength(0);
  });

  it('A5: redelivery converges — already-parked rows deduct nothing and error nothing', async () => {
    const missingOnce: DupesParkSeam['parkTab'] = (input) => {
      if (input.browserTabId === 43) {
        return Promise.resolve(
          err(ledgeError('E_NOT_FOUND_TAB', { operation: 'command:ParkTab', id: 43 })),
        );
      }
      return Promise.resolve(ok({ kept: `tab-${input.browserTabId}` }));
    };
    const h = await makeApp(missingOnce);
    for (const row of dupeRows()) await h.seedTab(row);
    const listed = await h.service.listDupeGroups(ctx);
    if (!listed.ok) throw new Error('list failed');
    const g = listed.value[0];
    if (g === undefined) throw new Error('group missing');
    const done = await h.service.parkDupeGroup(
      { canonHash: g.canonHash, keepBrowserTabId: 42 },
      ctx,
    );
    if (!done.ok) throw new Error('park failed');
    expect(done.value.parkedCount).toBe(1); // only the genuinely-parked count
  });

  it('A6: a real seam fault surfaces honestly (earlier parks stand; strip re-pulls)', async () => {
    const failing: DupesParkSeam['parkTab'] = (input) => {
      if (input.browserTabId === 41) {
        return Promise.resolve(err(ledgeError('E_CORRUPT_STORE', { table: 'tabs' })));
      }
      return Promise.resolve(ok({ kept: `tab-${input.browserTabId}` }));
    };
    const h = await makeApp(failing);
    for (const row of dupeRows()) await h.seedTab(row);
    const listed = await h.service.listDupeGroups(ctx);
    if (!listed.ok) throw new Error('list failed');
    const g = listed.value[0];
    if (g === undefined) throw new Error('group missing');
    const done = await h.service.parkDupeGroup(
      { canonHash: g.canonHash, keepBrowserTabId: 42 },
      ctx,
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.code).toBe('E_CORRUPT_STORE');
  });

  it('A7: dismiss rides the settings carrier (ADR-035) — event committed, group hidden, un-ignore restores', async () => {
    const h = await makeApp();
    for (const row of dupeRows()) await h.seedTab(row);
    const listed = await h.service.listDupeGroups(ctx);
    if (!listed.ok) throw new Error('list failed');
    const hash = listed.value[0]?.canonHash ?? '';
    const ignored = await h.service.setDupeGroupIgnored({ canonHash: hash, ignored: true }, ctx);
    if (!ignored.ok) throw new Error('ignore failed');
    const events = await h.events();
    const carriers = events.filter((e) => e.type === 'SettingsChanged');
    expect(carriers).toHaveLength(1);
    const p = carriers[0]?.payload as Record<string, unknown>;
    expect(p['key']).toBe(`${DUPE_IGNORE_PREFIX}${hash}`);
    expect(p['value']).toBe(true);
    const hidden = await h.service.listDupeGroups(ctx);
    if (!hidden.ok) throw new Error('list failed');
    expect(hidden.value).toHaveLength(0);
    const restored = await h.service.setDupeGroupIgnored({ canonHash: hash, ignored: false }, ctx);
    if (!restored.ok) throw new Error('unignore failed');
    const back = await h.service.listDupeGroups(ctx);
    if (!back.ok) throw new Error('list failed');
    expect(back.value).toHaveLength(1);
    const empty = await h.service.setDupeGroupIgnored({ canonHash: '  ', ignored: true }, ctx);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('E_DOMAIN_LEGALITY');
  });
});

describe('E8-T07 · v1.1 wire reserve (C-series)', () => {
  it('C1: ParkDupeTabs / IgnoreDupeGroup / GetDupeGroups are v1.1-dormant with frozen shapes', () => {
    expect(MESSAGE_REGISTRY['ParkDupeTabs']?.availability).toBe('v1.1');
    expect(MESSAGE_REGISTRY['ParkDupeTabs']?.response).toEqual({ parkedCount: 'int' });
    expect(MESSAGE_REGISTRY['IgnoreDupeGroup']?.payload).toEqual({
      canonHash: 'string',
      ignored: 'boolean',
    });
    expect(MESSAGE_REGISTRY['GetDupeGroups']?.response).toEqual({ groups: { array: 'unknown' } });
    const mk = (kind: 'command' | 'query', name: string, payload: unknown): MessageEnvelope => ({
      v: CONTRACT_V,
      kind,
      name,
      cid: '01KZTEST000000000000000001' as Id,
      senderContext: 'guardian',
      payload,
      contractHash: computeContractHash(),
    });
    for (const [kind, name, payload] of [
      ['command', 'ParkDupeTabs', { canonHash: 'h', keepBrowserTabId: 41 }],
      ['command', 'IgnoreDupeGroup', { canonHash: 'h', ignored: true }],
      ['query', 'GetDupeGroups', {}],
    ] as const) {
      const outcome = validateMessage(mk(kind, name, payload), { zone: 'zone0' });
      expect(outcome.type).toBe('ignored');
      if (outcome.type === 'ignored') expect(outcome.reason).toBe('unavailable-name');
    }
  });
});
