// E8-T09 · chaos lane — the C28 atomicity kill-point matrix (roadmap completion
// criterion: "Atomicity chaos-tested"; Spec W8: "If park fails, switch aborts…
// user never loses the current context by half-executing a switch"). Each
// scenario tears the single intent at one enumerated point; the INVARIANTS
// under every tear are identical:
//
//   I1  resume NEVER runs unless park succeeded        (no half-executed leap)
//   I2  a failed phase propagates ITS fault + phase    (never a re-labeled lie)
//   I3  a landed park is NEVER rolled back             (it is a lawful act;
//                                                        undo owns reversal)
//   I4  cancellation between phases throws the marker  (the context stands)
//   I5  redelivery converges — a replayed intent mints the SAME phase cids
//
// Diagram of the kill points:
//   K1 throw-during-park        → I1, I2
//   K2 reject-during-park       → I1, I2
//   K3 throw-during-resume      → I2, I3
//   K4 reject-during-resume     → I2, I3
//   K5 cancel-after-park        → I1, I4
//   K6 replay-the-same-cid      → I5
import { describe, expect, it } from 'vitest';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { createStreamAppender } from '@/application/usecases/shared/stream-appender.js';
import { createSwitcherService } from '@/application/usecases/switcher.js';
import type { SwitcherSeams } from '@/application/usecases/switcher.js';
import { isCancelledMarker } from '@/application/hub/dispatch/cancellation.js';
import type { ServiceDeps, ServiceEdge, UseCtx } from '@/application/usecases/shared/app-ctx.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';

const WALL = 1_900_200_000_000;
const TARGET = testId(90);
const SRC_WINDOW = 55;

interface ChaosHarness {
  readonly engine: StorageEnginePort;
  readonly parkCalls: readonly { readonly cid: string }[];
  readonly resumeCalls: readonly { readonly cid: string }[];
  readonly mk: (seams: Partial<SwitcherSeams>) => ReturnType<typeof createSwitcherService>;
  readonly mkCtx: (cid: string, flag: { cancelled: boolean }) => UseCtx;
}

const makeChaos = async (): Promise<ChaosHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const projections = createV1ProjectionEngine({ engine, journal, onDelta: () => undefined });
  const ids = createIdGenerator({
    now: () => WALL,
    randomBytes: (n: number) => new Uint8Array(n).fill(9),
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
  const parkCalls: { cid: string }[] = [];
  const resumeCalls: { cid: string }[] = [];
  const seeded = await engine.txn(['missions'], 'readwrite', async (tx) => {
    await tx.table('missions').put({
      missionId: TARGET,
      name: 'Chaos target',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabIds: ['t1'],
      createdAt: WALL,
      lastActiveAt: WALL - 1_000,
    });
  });
  if (!seeded.ok) throw new Error('seed failed');
  const base: SwitcherSeams = {
    parkWindow: (_input, c) => {
      parkCalls.push({ cid: c.cid });
      return Promise.resolve(ok({ missionId: 'm-src', keptCount: 3 }));
    },
    resumeMission: (_input, c) => {
      resumeCalls.push({ cid: c.cid });
      return Promise.resolve(ok({ windowId: 950, restored: 2, moved: 0 }));
    },
  };
  return {
    engine,
    parkCalls,
    resumeCalls,
    mk: (seams) => createSwitcherService(edge, { ...base, ...seams }),
    mkCtx: (cid, flag) => ({
      cid,
      token: {
        cid,
        isCancelled: () => flag.cancelled,
        throwIfCancelled: () => {
          if (flag.cancelled) throw { kind: 'cancelled', cid };
        },
      },
      progress: {
        emit: () => undefined,
        readonly: () => undefined,
      } as unknown as UseCtx['progress'],
      notifyPending: () => undefined,
    }),
  };
};

const liveFlag = { cancelled: false };

describe('E8-T09 · C28 atomicity kill-point matrix (chaos)', () => {
  it('K1/K2: park torn (sync throw · async reject) ⇒ resume NEVER runs, fault propagates', async () => {
    const h = await makeChaos();
    for (const mode of ['throw', 'reject'] as const) {
      const parkWindow: SwitcherSeams['parkWindow'] =
        mode === 'throw'
          ? () => {
              throw ledgeError('E_CORRUPT_STORE', { table: 'missions', phase: 'sabotage-throw' });
            }
          : () =>
              Promise.resolve(err(ledgeError('E_JOURNAL_INTEGRITY', { phase: 'sabotage-reject' })));
      const service = h.mk({ parkWindow });
      const ctx = h.mkCtx(`cid-k-${mode}`, liveFlag);
      let outcome: unknown;
      try {
        outcome = await service.switchMission(
          { targetMissionId: TARGET, parkCurrent: true, sourceWindowId: SRC_WINDOW },
          ctx,
        );
      } catch (caught) {
        outcome = caught; // I2: a THROWN sabotage escapes as a throw (no phase wrap — nothing was recorded)
      }
      expect(h.resumeCalls).toHaveLength(0); // I1
      if (mode === 'throw') {
        // The throw escapes raw — the hub maps markers/faults upstream; here
        // the criterion is narrower: the chain NEVER proceeded to resume.
        expect(outcome).toMatchObject({ code: 'E_CORRUPT_STORE' });
      } else {
        const r = outcome as Awaited<ReturnType<typeof service.switchMission>>;
        expect(r.ok).toBe(false); // I2: fault mapped to the park anomaly, phase pinned
        if (!r.ok) {
          expect(r.error.code).toBe('E_JOURNAL_INTEGRITY');
          expect(r.error.details?.['phase']).toBe('park');
          expect(r.error.details?.['aborted']).toBe(true);
        }
      }
    }
  });

  it('K3/K4: resume torn (throw · reject) after a landed park ⇒ phase named, park kept', async () => {
    for (const mode of ['throw', 'reject'] as const) {
      const h = await makeChaos();
      const resumeMission: SwitcherSeams['resumeMission'] =
        mode === 'throw'
          ? () => {
              throw ledgeError('E_NOT_FOUND_TAB', { id: 999 });
            }
          : () => Promise.resolve(err(ledgeError('E_PROVIDER_TIMEOUT', { ms: 30_000 })));
      const service = h.mk({ resumeMission });
      const ctx = h.mkCtx(`cid-k-${mode}`, liveFlag);
      let outcome: unknown;
      try {
        outcome = await service.switchMission(
          { targetMissionId: TARGET, parkCurrent: true, sourceWindowId: SRC_WINDOW },
          ctx,
        );
      } catch (caught) {
        outcome = caught;
      }
      expect(h.parkCalls).toHaveLength(1); // I3: the park happened and stands
      if (mode === 'throw') {
        expect(outcome).toMatchObject({ code: 'E_NOT_FOUND_TAB' }); // I2: raw fault escapes; hub maps upstream
      } else {
        const r = outcome as Awaited<ReturnType<typeof service.switchMission>>;
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('E_PROVIDER_TIMEOUT');
          expect(r.error.details?.['phase']).toBe('resume');
          expect(r.error.details?.['parked']).toBe(true); // honest partial
        }
      }
    }
  });

  it('K5: cancelled between phases ⇒ marker thrown BEFORE the leap; both contexts stand', async () => {
    const h = await makeChaos();
    const tripWire = { cancelled: false };
    const parkRecorded: string[] = [];
    const parkWindow: SwitcherSeams['parkWindow'] = (_input, c) => {
      parkRecorded.push(c.cid);
      tripWire.cancelled = true; // the sabotage: cancel lands mid-chain
      return Promise.resolve(ok({ missionId: 'm-src', keptCount: 3 }));
    };
    const service = h.mk({ parkWindow });
    const ctx = h.mkCtx('cid-k5', tripWire);
    let caught: unknown;
    try {
      await service.switchMission(
        { targetMissionId: TARGET, parkCurrent: true, sourceWindowId: SRC_WINDOW },
        ctx,
      );
    } catch (e) {
      caught = e;
    }
    expect(isCancelledMarker(caught)).toBe(true); // I4
    expect(parkRecorded).toEqual(['cid-k5:park']); // I3: the landed park stands
    expect(h.resumeCalls).toHaveLength(0); // I1: the leap never happened
  });

  it('K6: a replayed intent mints the same phase cids (§2.12 redelivery converges upstream)', async () => {
    const h = await makeChaos();
    const service = h.mk({});
    for (const attempt of [1, 2]) {
      const ctx = h.mkCtx('cid-replay', { cancelled: false });
      const r = await service.switchMission(
        { targetMissionId: TARGET, parkCurrent: true, sourceWindowId: SRC_WINDOW },
        ctx,
      );
      if (!r.ok) throw new Error(`replay ${attempt} failed`);
    }
    expect(h.parkCalls.map((c) => c.cid)).toEqual(['cid-replay:park', 'cid-replay:park']);
    expect(h.resumeCalls.map((c) => c.cid)).toEqual(['cid-replay:resume', 'cid-replay:resume']);
    // I5: identical cids across replays — the LEDGER dedupes downstream
    // (park/resume services own cid idempotence; the switcher owes them).
  });
});
