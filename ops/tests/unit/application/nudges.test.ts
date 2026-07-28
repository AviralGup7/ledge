// E8-T08 · sprawl nudge law (roadmap completion criterion: "R15 bucket
// semantics fixtures" — the F-series IS that criterion, pinned against the
// host-offset clock math). S-series: evidence (facts, oldest-first). T-series:
// the §6.10 timing window (14-day ⇒ third-forever, cap one). F-series: R15
// local-midnight buckets. A-series: the use-case — errs-to-never ordering,
// sticky-within-day, act-on-now, convergent idempotence, dismissal memory.
// C-series: the v1.1 reserve wire (frozen shape, unavailable-name today).
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import {
  createNudgesService,
  META_NUDGE_DAY_PREFIX,
  META_NUDGE_DISMISS_PREFIX,
  NUDGE_TYPE_SPRAWL,
  SETTING_SUGGESTIONS_ALL,
  SETTING_SUGGESTIONS_NUDGES,
} from '@/application/usecases/nudges.js';
import type { NudgesParkSeam, SprawlNudgeOffer } from '@/application/usecases/nudges.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import {
  SPRAWL_MIN_STALE_COUNT,
  SPRAWL_STALE_AGE_MS,
  sprawlOfferable,
  sprawlStaleTabs,
  type SprawlTabEvidence,
} from '@/domain/lifecycle/index.js';
import {
  NUDGE_DISMISS_FOREVER_COUNT,
  NUDGE_DISMISS_SUPPRESS_MS,
  localMidnightFloor,
  nudgeWindow,
} from '@/domain/memory/index.js';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import { computeContractHash, validateMessage } from '@/application/contracts/index.js';
import { MESSAGE_REGISTRY } from '@/application/contracts/message.registry.js';
import type { MessageEnvelope } from '@/application/contracts/envelope.js';
import { ok, err, ledgeError } from '@/shared-kernel/result/index.js';
import type { Id } from '@/shared-kernel/identity/index.js';

const WALL = 1_900_000_000_000;
const DAY_MS = 86_400_000;
const IST_OFFSET = 330; // UTC+5:30 — Rudrapur's own clock makes the fixture honest

const ev = (
  over: Partial<SprawlTabEvidence> & { readonly browserTabId: number },
): SprawlTabEvidence => ({
  ledgeTabId: over.ledgeTabId ?? testId(over.browserTabId),
  browserTabId: over.browserTabId,
  title: over.title ?? 'a tab',
  domain: over.domain ?? 'example.com',
  lastActiveAt: over.lastActiveAt ?? WALL,
});

describe('E8-T08 · evidence law (S-series: facts, never psychics)', () => {
  it('S1: stale = lastActiveAt strictly before the cutoff; cohort answers oldest-first (ties by id)', () => {
    const staleOld = ev({ browserTabId: 1, lastActiveAt: WALL - SPRAWL_STALE_AGE_MS - DAY_MS });
    const staleNewish = ev({ browserTabId: 2, lastActiveAt: WALL - SPRAWL_STALE_AGE_MS - 1 });
    const boundaryFresh = ev({ browserTabId: 3, lastActiveAt: WALL - SPRAWL_STALE_AGE_MS }); // NOT stale: strictly-before law
    const fresh = ev({ browserTabId: 4, lastActiveAt: WALL - 1_000 });
    const unknowable = ev({ browserTabId: 5, lastActiveAt: 0 }); // excluded: never claim age you cannot show
    const cohort = sprawlStaleTabs([fresh, staleNewish, unknowable, staleOld, boundaryFresh], WALL);
    expect(cohort.map((t) => t.browserTabId)).toEqual([1, 2]);
  });

  it('S2: the offer floor is the spec-numbered cohort (6); below it the model stays silent', () => {
    expect(SPRAWL_MIN_STALE_COUNT).toBe(6); // Spec §6.10's own example count
    expect(sprawlOfferable(SPRAWL_MIN_STALE_COUNT)).toBe(true);
    expect(sprawlOfferable(SPRAWL_MIN_STALE_COUNT - 1)).toBe(false);
  });
});

describe('E8-T08 · timing window (T-series: §6.10 errs to never)', () => {
  it('T1..T5: allow ⇒ recently-dismissed ⇒ window-edge ⇒ daily-cap ⇒ third-is-forever', () => {
    expect(nudgeWindow({ now: WALL, offeredTodayCount: 0 })).toEqual({ kind: 'allow' });
    const recent = nudgeWindow({
      now: WALL,
      offeredTodayCount: 0,
      dismissal: { count: 1, lastDismissedAt: WALL - 1_000 },
    });
    expect(recent).toEqual({ kind: 'suppressed', reason: 'dismissed-recently' });
    // Edge honesty: suppression is STRICTLY inside the window; at the window it lifts.
    const lifted = nudgeWindow({
      now: WALL,
      offeredTodayCount: 0,
      dismissal: { count: 1, lastDismissedAt: WALL - NUDGE_DISMISS_SUPPRESS_MS },
    });
    expect(lifted).toEqual({ kind: 'allow' });
    expect(nudgeWindow({ now: WALL, offeredTodayCount: 1 })).toEqual({
      kind: 'suppressed',
      reason: 'daily-cap',
    });
    const forever = nudgeWindow({
      now: WALL,
      offeredTodayCount: 0,
      dismissal: { count: NUDGE_DISMISS_FOREVER_COUNT, lastDismissedAt: WALL - 90 * DAY_MS },
    });
    expect(forever).toEqual({ kind: 'suppressed', reason: 'dismissed-forever' });
  });

  it('T6: garbage memory reads safe (unknown count ⇒ zero; unknown stamp ⇒ never)', () => {
    expect(
      nudgeWindow({
        now: WALL,
        offeredTodayCount: 0,
        dismissal: { count: Number.NaN, lastDismissedAt: Number.NaN },
      }),
    ).toEqual({ kind: 'allow' });
  });
});

describe('E8-T08 · R15 bucket semantics fixtures (the completion criterion)', () => {
  // IST midnight is 18:30:00.000Z. Two instants 2s apart straddle an IST day.
  const IST_MIDNIGHT_Z = Date.UTC(2026, 6, 28, 18, 30, 0); // = 2026-07-29 00:00:00 IST

  it('F1: IST local-midnight floor — 18:29:59Z and 18:30:01Z land in DIFFERENT buckets (no cross-day carry)', () => {
    const before = localMidnightFloor(IST_MIDNIGHT_Z - 1, IST_OFFSET);
    const after = localMidnightFloor(IST_MIDNIGHT_Z + 1, IST_OFFSET);
    expect(before).not.toBe(after);
    expect(after).toBe(IST_MIDNIGHT_Z); // the floor IS local midnight, in epoch ms
    expect(before).toBe(IST_MIDNIGHT_Z - DAY_MS);
  });

  it('F2: UTC offset — the same two instants share one bucket (UTC midnight is elsewhere)', () => {
    const before = localMidnightFloor(IST_MIDNIGHT_Z - 1, 0);
    const after = localMidnightFloor(IST_MIDNIGHT_Z + 1, 0);
    expect(before).toBe(after); // 18:29/18:30 UTC are the same UTC day
  });

  it('F3: a timezone change lengthens/shortens a day — different offsets disagree and NOTHING corrects', () => {
    const istFloor = localMidnightFloor(IST_MIDNIGHT_Z + 1, IST_OFFSET);
    const utcFloor = localMidnightFloor(IST_MIDNIGHT_Z + 1, 0);
    // R15 verbatim: "Timezone changes simply lengthen/shorten a day — no
    // correction logic." The fixture pins that the same instant can belong
    // to two different days depending on the device clock, and no rule
    // reconciles that.
    expect(istFloor).not.toBe(utcFloor);
  });

  it('F4: the floor is a floor — flooring a floor changes nothing', () => {
    const once = localMidnightFloor(IST_MIDNIGHT_Z + 12_345, IST_OFFSET);
    expect(localMidnightFloor(once, IST_OFFSET)).toBe(once);
  });
});

// ── application harness (prefs-style edge; rows seeded straight into stores) ──
const ctx: UseCtx = {
  cid: 'cid-nudges',
  token: { cid: 'cid-nudges', isCancelled: () => false, throwIfCancelled: () => undefined },
  progress: { emit: () => undefined, readonly: () => undefined } as unknown as UseCtx['progress'],
  notifyPending: () => undefined,
};

interface AppHarness {
  readonly engine: StorageEnginePort;
  readonly service: ReturnType<typeof createNudgesService>;
  readonly parkCalls: readonly number[];
  readonly events: () => Promise<readonly EventEnvelope[]>;
  readonly seedTab: (browserTabId: number, lastActiveAt: number, state?: string) => Promise<void>;
  readonly parkAllSeeded: () => Promise<void>;
  readonly putSetting: (key: string, value: boolean) => Promise<void>;
  readonly readMetaValue: (key: string) => Promise<unknown>;
  readonly advance: (ms: number) => void;
}

const makeApp = async (parkScript?: NudgesParkSeam['parkTab']): Promise<AppHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  const ids = createIdGenerator({
    now: () => WALL,
    randomBytes: (n: number) => new Uint8Array(n).fill(5),
  });
  let nowValue = WALL;
  const deps = {
    engine,
    journal,
    projections,
    ids,
    deviceId: DEV_A,
    now: () => nowValue,
  } as unknown as ServiceDeps;
  const appender = createStreamAppender({
    journal,
    projections,
    deviceId: DEV_A,
    ids,
    now: deps.now,
  });
  const edge: ServiceEdge = { deps, appender };
  const calls: number[] = [];
  const seam: NudgesParkSeam = {
    parkTab:
      parkScript ??
      ((input) => {
        calls.push(input.browserTabId);
        return Promise.resolve(ok({ kept: `tab-${input.browserTabId}` }));
      }),
  };
  const seeded: number[] = [];
  return {
    engine,
    service: createNudgesService(edge, seam, { offsetMinutes: () => 0 }),
    parkCalls: calls,
    events: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error('readRange failed');
      return r.value.events.map((e) => e.envelope);
    },
    seedTab: async (browserTabId, lastActiveAt, state = 'live') => {
      seeded.push(browserTabId);
      const r = await engine.txn(['tabs'], 'readwrite', async (tx) => {
        await tx.table('tabs').put({
          ledgeTabId: testId(browserTabId),
          missionId: '',
          url: `https://sprawl.example/${browserTabId}`,
          title: `tab ${browserTabId}`,
          domain: 'sprawl.example',
          state,
          firstSeenAt: lastActiveAt,
          lastActiveAt,
          browserTabId,
        });
      });
      if (!r.ok) throw new Error('seed failed');
    },
    parkAllSeeded: async () => {
      const r = await engine.txn(['tabs'], 'readwrite', async (tx) => {
        for (const id of seeded) {
          const row = await tx.table<{ [k: string]: unknown }>('tabs').get(testId(id));
          if (row !== undefined) await tx.table('tabs').put({ ...row, state: 'parked' });
        }
      });
      if (!r.ok) throw new Error('park-all failed');
    },
    putSetting: async (key, value) => {
      const r = await engine.txn(['settings'], 'readwrite', async (tx) => {
        await tx.table('settings').put({ key, value, schemaV: 1, updatedAt: WALL });
      });
      if (!r.ok) throw new Error('setting failed');
    },
    readMetaValue: async (key) => {
      const r = await engine.txn(['meta'], 'readonly', async (tx) => {
        const row = await tx.table<{ [k: string]: unknown }>('meta').get(key);
        return row?.['value'];
      });
      if (!r.ok) throw new Error('meta read failed');
      return r.value;
    },
    advance: (ms) => {
      nowValue += ms;
    },
  };
};

const STALE_AT = WALL - SPRAWL_STALE_AGE_MS - DAY_MS;
const seedCohort = async (h: AppHarness, count: number): Promise<void> => {
  for (let i = 1; i <= count; i += 1) await h.seedTab(100 + i, STALE_AT - i * 1_000);
};

const pendingValue = async (h: AppHarness): Promise<SprawlNudgeOffer | null> => {
  const r = await h.service.pendingSprawlNudge(ctx);
  if (!r.ok) throw new Error(`pending failed: ${r.error.code}`);
  return r.value;
};

describe('E8-T08 · nudge law (A-series: silence is the default state)', () => {
  it('A1: one whisper a day — offer + NudgeOffered event + day counter; same-day re-pull is the SAME offer', async () => {
    const h = await makeApp();
    await seedCohort(h, 6);
    const first = await h.service.pendingSprawlNudge(ctx);
    if (!first.ok || first.value === null) throw new Error('whisper missing');
    expect(first.value.staleCount).toBe(6);
    expect(first.value.nudgeType).toBe(NUDGE_TYPE_SPRAWL);
    const events = await h.events();
    const offers = events.filter((e) => e.type === 'NudgeOffered');
    expect(offers).toHaveLength(1);
    const p = offers[0]?.payload as Record<string, unknown>;
    expect(p['staleCount']).toBe(6);
    expect(p['nudgeOfferId']).toBe(first.value.offerId);
    const dayRow = (await h.readMetaValue(
      `${META_NUDGE_DAY_PREFIX}${first.value.dayBucket}`,
    )) as Record<string, unknown>;
    expect(dayRow['count']).toBe(1);
    // Stickiness: the same day re-answers the SAME whisper (a re-render is
    // not a new offer — no second event, no counter bump).
    const again = await h.service.pendingSprawlNudge(ctx);
    if (!again.ok || again.value === null) throw new Error('sticky whisper missing');
    expect(again.value.offerId).toBe(first.value.offerId);
    expect((await h.events()).filter((e) => e.type === 'NudgeOffered')).toHaveLength(1);
  });

  it('A2: a new LOCAL day earns a new whisper (R15 no-carry: the bucket rolls)', async () => {
    const h = await makeApp();
    await seedCohort(h, 7);
    const day1 = await h.service.pendingSprawlNudge(ctx);
    if (!day1.ok || day1.value === null) throw new Error('day-1 whisper missing');
    h.advance(DAY_MS); // UTC offset ⇒ next epoch day = next local day
    const day2 = await h.service.pendingSprawlNudge(ctx);
    if (!day2.ok || day2.value === null) throw new Error('day-2 whisper missing');
    expect(day2.value.offerId).not.toBe(day1.value.offerId);
    expect(day2.value.dayBucket).not.toBe(day1.value.dayBucket);
    expect((await h.events()).filter((e) => e.type === 'NudgeOffered')).toHaveLength(2);
  });

  it('A3: the switches mute — explicit false answers silence, writes nothing, offers nothing', async () => {
    const h = await makeApp();
    await seedCohort(h, 8);
    await h.putSetting(SETTING_SUGGESTIONS_ALL, false);
    expect(await pendingValue(h)).toBeNull();
    expect((await h.events()).filter((e) => e.type === 'NudgeOffered')).toHaveLength(0);
    const metaKeys = await h.readMetaValue(`${META_NUDGE_DISMISS_PREFIX}${NUDGE_TYPE_SPRAWL}`);
    expect(metaKeys).toBeUndefined();
    // Per-capability toggle alone mutes too (§12.1).
    const h2 = await makeApp();
    await seedCohort(h2, 8);
    await h2.putSetting(SETTING_SUGGESTIONS_NUDGES, false);
    expect(await pendingValue(h2)).toBeNull();
  });

  it('A4: dismissal memory — 14-day silence, third dismissal is forever (§5.8/§6.10)', async () => {
    const h = await makeApp();
    await seedCohort(h, 6);
    const first = await h.service.pendingSprawlNudge(ctx);
    if (!first.ok || first.value === null) throw new Error('whisper missing');
    const dismissed = await h.service.dismissSprawlNudge({ offerId: first.value.offerId }, ctx);
    if (!dismissed.ok) throw new Error('dismiss failed');
    expect(await pendingValue(h)).toBeNull(); // misfire ⇒ silence
    h.advance(NUDGE_DISMISS_SUPPRESS_MS); // the window lifts…
    h.advance(1);
    const second = await h.service.pendingSprawlNudge(ctx);
    if (!second.ok || second.value === null) throw new Error('second whisper missing'); // …but day moved too (R15), so a fresh whisper is lawful
    // Three dismissals ⇒ forever, however much time passes.
    for (const offerId of [first.value.offerId, second.value.offerId]) {
      const d = await h.service.dismissSprawlNudge({ offerId }, ctx);
      if (!d.ok) throw new Error('dismiss failed');
    }
    const memory = (await h.readMetaValue(
      `${META_NUDGE_DISMISS_PREFIX}${NUDGE_TYPE_SPRAWL}`,
    )) as Record<string, unknown>;
    expect(memory['count']).toBe(3);
    h.advance(90 * DAY_MS);
    expect(await pendingValue(h)).toBeNull();
  });

  it('A5: thin evidence is silence — five stale tabs never spend the day slot', async () => {
    const h = await makeApp();
    await seedCohort(h, 5);
    expect(await pendingValue(h)).toBeNull();
    expect((await h.events()).filter((e) => e.type === 'NudgeOffered')).toHaveLength(0);
  });

  it('A6: a dissolved cohort lulls the whisper — sticky stops when the evidence does', async () => {
    const h = await makeApp();
    await seedCohort(h, 6);
    const first = await h.service.pendingSprawlNudge(ctx);
    if (!first.ok || first.value === null) throw new Error('whisper missing');
    await h.parkAllSeeded(); // the user tidied up elsewhere — the whisper is moot
    expect(await pendingValue(h)).toBeNull();
  });

  it('A7: the tap parks exactly the re-derived cohort; redelivery converges; empty id is legality-calm', async () => {
    const h = await makeApp();
    await seedCohort(h, 6);
    await h.seedTab(200, WALL - 100); // fresh tab — NOT in the cohort
    const first = await h.service.pendingSprawlNudge(ctx);
    if (!first.ok || first.value === null) throw new Error('whisper missing');
    const acted = await h.service.actOnSprawlNudge({ offerId: first.value.offerId }, ctx);
    if (!acted.ok) throw new Error('act failed');
    expect(acted.value.parkedCount).toBe(6);
    expect(h.parkCalls).toHaveLength(6);
    expect(h.parkCalls).not.toContain(200);
    expect(h.parkCalls[0]).toBe(106); // oldest-first (seeded with growing staleness)
    const empty = await h.service.actOnSprawlNudge({ offerId: ' ' }, ctx);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('E_DOMAIN_LEGALITY');
    const emptyDismiss = await h.service.dismissSprawlNudge({ offerId: '' }, ctx);
    expect(emptyDismiss.ok).toBe(false);
  });

  it('A8: acting with a partially-missing cohort converges (E_NOT_FOUND_TAB deducts nothing)', async () => {
    const missingOnce: NudgesParkSeam['parkTab'] = (input) => {
      if (input.browserTabId === 102) {
        return Promise.resolve(
          err(ledgeError('E_NOT_FOUND_TAB', { operation: 'command:ParkTab', id: 102 })),
        );
      }
      return Promise.resolve(ok({ kept: `tab-${input.browserTabId}` }));
    };
    const h = await makeApp(missingOnce);
    await seedCohort(h, 6);
    const first = await h.service.pendingSprawlNudge(ctx);
    if (!first.ok || first.value === null) throw new Error('whisper missing');
    const acted = await h.service.actOnSprawlNudge({ offerId: first.value.offerId }, ctx);
    if (!acted.ok) throw new Error('act failed');
    expect(acted.value.parkedCount).toBe(5); // one row already converged
  });
});

describe('E8-T08 · v1.1 wire reserve (C-series)', () => {
  it('C1: DismissSprawlNudge / GetPendingNudge are v1.1-dormant with frozen shapes', () => {
    expect(MESSAGE_REGISTRY['DismissSprawlNudge']?.availability).toBe('v1.1');
    expect(MESSAGE_REGISTRY['DismissSprawlNudge']?.payload).toEqual({ offerId: 'string' });
    expect(MESSAGE_REGISTRY['GetPendingNudge']?.availability).toBe('v1.1');
    expect(MESSAGE_REGISTRY['GetPendingNudge']?.response).toEqual({ nudge: 'unknown' });
    const mk = (kind: 'command' | 'query', name: string, payload: unknown): MessageEnvelope => ({
      v: CONTRACT_V,
      kind,
      name,
      cid: '01KZTEST000000000000000002' as Id,
      senderContext: 'guardian',
      payload,
      contractHash: computeContractHash(),
    });
    for (const [kind, name, payload] of [
      ['command', 'DismissSprawlNudge', { offerId: 'o1' }],
      ['query', 'GetPendingNudge', {}],
    ] as const) {
      const outcome = validateMessage(mk(kind, name, payload), { zone: 'zone0' });
      expect(outcome.type).toBe('ignored');
      if (outcome.type === 'ignored') expect(outcome.reason).toBe('unavailable-name');
    }
  });
});
