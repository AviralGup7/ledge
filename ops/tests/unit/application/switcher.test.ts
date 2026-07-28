// E8-T09 · switcher law (roadmap completion: "Atomicity chaos-tested" — the
// W-series here pins the phase law; ops/tests/chaos/switch-atomicity.chaos.test.ts
// is the kill-point matrix). O-series: the W8 order (open-first, parked-next,
// totality). W-series: the C28 single intent — park-fail ABORTS (resume never
// runs), resume-fail is honest partial, open targets answer focus-truth, and
// reads never act.
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import { createSwitcherService } from '@/application/usecases/switcher.js';
import type { SwitcherSeams } from '@/application/usecases/switcher.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import { switcherClassOf, switcherOrder } from '@/domain/lifecycle/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';

const WALL = 1_900_100_000_000;

describe('E8-T09 · order law (O-series: Spec W8 verbatim)', () => {
  const m = (id: string, state: string, lastActiveAt: number, name = `m-${id}`) => ({
    missionId: id,
    name,
    state,
    lastActiveAt,
  });

  it('O1: open-first then parked-next; recency desc inside each; deterministic ties', () => {
    const openOld = m('open-old', 'live', WALL - 9_000);
    const openHot = m('open-hot', 'live', WALL - 100);
    const parkedHot = m('parked-hot', 'parked', WALL - 5);
    const parkedOld = m('parked-old', 'parked', WALL - 50_000);
    const archived = m('archived', 'archived', WALL - 700);
    const order = switcherOrder([parkedOld, openOld, archived, parkedHot, openHot]);
    expect(order.map((x) => x.missionId)).toEqual([
      'open-hot',
      'open-old',
      'parked-hot',
      'archived',
      'parked-old',
    ]);
  });

  it('O2: totality — trash and unknown classes are never offered (resume would refuse)', () => {
    expect(switcherClassOf('live')).toBe('open');
    expect(switcherClassOf('parked')).toBe('parked');
    expect(switcherClassOf('archived')).toBe('parked');
    expect(switcherClassOf('trash')).toBeNull();
    expect(switcherClassOf('garbage')).toBeNull();
    const order = switcherOrder([m('gone', 'trash', WALL), m('weird', '???', WALL)]);
    expect(order).toHaveLength(0);
  });
});

// ── application harness (seam-scripted; missions seeded straight into the store) ──
const ctx: UseCtx = {
  cid: 'cid-switch',
  token: { cid: 'cid-switch', isCancelled: () => false, throwIfCancelled: () => undefined },
  progress: { emit: () => undefined, readonly: () => undefined } as unknown as UseCtx['progress'],
  notifyPending: () => undefined,
};

interface AppHarness {
  readonly engine: StorageEnginePort;
  readonly service: ReturnType<typeof createSwitcherService>;
  readonly parkCalls: readonly { readonly windowId: number; readonly cid: string }[];
  readonly resumeCalls: readonly { readonly missionId: string; readonly cid: string }[];
  readonly seedMission: (
    missionId: string,
    state: string,
    lastActiveAt: number,
    extra?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}

const makeApp = async (seams?: Partial<SwitcherSeams>): Promise<AppHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  const ids = createIdGenerator({
    now: () => WALL,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  });
  const now = (): number => WALL;
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
  const parkCalls: { windowId: number; cid: string }[] = [];
  const resumeCalls: { missionId: string; cid: string }[] = [];
  const script: SwitcherSeams = {
    parkWindow:
      seams?.parkWindow ??
      ((input, c) => {
        parkCalls.push({ windowId: input.windowId, cid: c.cid });
        return Promise.resolve(ok({ missionId: 'm-parked-source', keptCount: 4 }));
      }),
    resumeMission:
      seams?.resumeMission ??
      ((input, c) => {
        resumeCalls.push({ missionId: input.missionId, cid: c.cid });
        return Promise.resolve(ok({ windowId: 910, restored: 7, moved: 0 }));
      }),
  };
  return {
    engine,
    service: createSwitcherService(edge, script),
    parkCalls,
    resumeCalls,
    seedMission: async (missionId, state, lastActiveAt, extra = {}) => {
      const r = await engine.txn(['missions'], 'readwrite', async (tx) => {
        await tx.table('missions').put({
          missionId,
          name: `Mission ${missionId.slice(-4)}`,
          namedBy: 'user',
          state,
          concluded: false,
          tabIds: ['t1', 't2'],
          createdAt: lastActiveAt,
          lastActiveAt,
          ...extra,
        });
      });
      if (!r.ok) throw new Error('seed failed');
    },
  };
};

const PARKED = testId(70);
const OPEN = testId(71);

describe('E8-T09 · C28 atomic single intent (W-series)', () => {
  it('W1: switch to a parked target rides resume(full) only — no park, honest outcome', async () => {
    const h = await makeApp();
    await h.seedMission(PARKED, 'parked', WALL - 1_000);
    const r = await h.service.switchMission({ targetMissionId: PARKED, parkCurrent: false }, ctx);
    if (!r.ok) throw new Error('switch failed');
    expect(r.value).toEqual({
      outcome: 'switched',
      parked: false,
      keptCount: 0,
      windowId: 910,
      restored: 7,
      moved: 0,
    });
    expect(h.parkCalls).toHaveLength(0);
    expect(h.resumeCalls.map((c) => c.missionId)).toEqual([PARKED]);
    expect(h.resumeCalls[0]?.cid).toBe('cid-switch:resume');
  });

  it('W2 · CRITERION (atomicity): park failure ABORTS the whole intent — resume NEVER runs', async () => {
    const failing: SwitcherSeams['parkWindow'] = () =>
      Promise.resolve(
        err(ledgeError('E_CORRUPT_STORE', { operation: 'command:ParkWindow', disk: 'full' })),
      );
    const h = await makeApp({ parkWindow: failing });
    await h.seedMission(PARKED, 'parked', WALL - 1_000);
    const r = await h.service.switchMission(
      { targetMissionId: PARKED, parkCurrent: true, sourceWindowId: 55 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_CORRUPT_STORE'); // the ORIGINAL fault, not a re-labeled one
      expect(r.error.details?.['phase']).toBe('park');
      expect(r.error.details?.['aborted']).toBe(true);
    }
    expect(h.resumeCalls).toHaveLength(0); // the switch never ran: current context stands
  });

  it('W3: parkCurrent chains park→resume checkpointed (cid:park, cid:resume), outcome honest', async () => {
    const h = await makeApp();
    await h.seedMission(PARKED, 'parked', WALL - 1_000);
    const r = await h.service.switchMission(
      { targetMissionId: PARKED, parkCurrent: true, sourceWindowId: 55 },
      ctx,
    );
    if (!r.ok) throw new Error('switch failed');
    expect(r.value).toEqual({
      outcome: 'switched',
      parked: true,
      keptCount: 4,
      windowId: 910,
      restored: 7,
      moved: 0,
    });
    expect(h.parkCalls).toEqual([{ windowId: 55, cid: 'cid-switch:park' }]);
    expect(h.resumeCalls[0]?.cid).toBe('cid-switch:resume');
  });

  it('W4: a resume failure after a landed park is an honest partial — phase named, park kept', async () => {
    const failing: SwitcherSeams['resumeMission'] = () =>
      Promise.resolve(err(ledgeError('E_CORRUPT_STORE', { table: 'missions' })));
    const h = await makeApp({ resumeMission: failing });
    await h.seedMission(PARKED, 'parked', WALL - 1_000);
    const r = await h.service.switchMission(
      { targetMissionId: PARKED, parkCurrent: true, sourceWindowId: 55 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_CORRUPT_STORE');
      expect(r.error.details?.['phase']).toBe('resume');
      expect(r.error.details?.['parked']).toBe(true); // the context stands — parked, safe, undoable
    }
    expect(h.parkCalls).toHaveLength(1); // the park is NOT rolled back (it is a lawful act)
  });

  it('W5: an open target answers focus-truth (no resume — C7 precondition never risked)', async () => {
    const h = await makeApp();
    await h.seedMission(OPEN, 'live', WALL - 100, { windowBinding: 42 });
    const r = await h.service.switchMission({ targetMissionId: OPEN, parkCurrent: false }, ctx);
    if (!r.ok) throw new Error('focus failed');
    expect(r.value).toEqual({ outcome: 'focus-window', parked: false, keptCount: 0, windowId: 42 });
    expect(h.resumeCalls).toHaveLength(0);
    // The current window CAN still park first — the chain law is target-shaped, not target-gated.
    const r2 = await h.service.switchMission(
      { targetMissionId: OPEN, parkCurrent: true, sourceWindowId: 55 },
      ctx,
    );
    if (!r2.ok) throw new Error('park+focus failed');
    expect(r2.value).toEqual({ outcome: 'focus-window', parked: true, keptCount: 4, windowId: 42 });
  });

  it('W6: malformed doors are calm legality answers (target-empty · source-window-required · target-gone)', async () => {
    const h = await makeApp();
    const empty = await h.service.switchMission({ targetMissionId: ' ', parkCurrent: false }, ctx);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.details?.['reason']).toBe('target-empty');
    const nosource = await h.service.switchMission(
      { targetMissionId: PARKED, parkCurrent: true },
      ctx,
    );
    expect(nosource.ok).toBe(false);
    if (!nosource.ok) expect(nosource.error.details?.['reason']).toBe('source-window-required');
    const gone = await h.service.switchMission(
      { targetMissionId: PARKED, parkCurrent: false },
      ctx,
    );
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.details?.['reason']).toBe('target-gone');
    expect(h.parkCalls).toHaveLength(0);
    expect(h.resumeCalls).toHaveLength(0);
  });

  it('W7: the list answers W8 order from rows — and reads NEVER act', async () => {
    const h = await makeApp();
    await h.seedMission(testId(80), 'live', WALL - 900);
    await h.seedMission(testId(81), 'live', WALL - 10, { windowBinding: 7 });
    await h.seedMission(testId(82), 'parked', WALL - 5);
    await h.seedMission(testId(83), 'archived', WALL - 50_000);
    await h.seedMission(testId(84), 'trash', WALL - 1);
    const listed = await h.service.listSwitcher(ctx);
    if (!listed.ok) throw new Error('list failed');
    expect(listed.value.map((i) => i.cls)).toEqual(['open', 'open', 'parked', 'parked']);
    expect(listed.value[0]?.missionId).toBe(testId(81));
    expect(listed.value[0]?.windowId).toBe(7);
    expect(listed.value[2]?.missionId).toBe(testId(82));
    expect(listed.value.some((i) => i.missionId === testId(84))).toBe(false);
    expect(h.parkCalls).toHaveLength(0);
    expect(h.resumeCalls).toHaveLength(0); // reading never acts
  });
});
