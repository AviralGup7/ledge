// E3-APP · Resume/restore contract (§6.5, C7). Locking laws:
//  (1) the durable accept (ResumeAccepted/RestoreAccepted) lands BEFORE the browser
//      move — a crash mid-restore replays from truth, never double-executes;
//  (2) C7 open-check idempotency: resuming an already-live mission answers without
//      re-creating windows (resend-safe);
//  (3) MissionResumed carries the ACTUAL mapping (windowId + per-tab browser coords);
//  (4) partial⊆mission legality is domain-decided; foreign tabIds are refused.
import { describe, expect, it } from 'vitest';
import { testId } from './services.testkit.js';
import {
  browserTabIdOf,
  ledgeTabIdOf,
  liveTabPlan,
  makeServices,
  mustOk,
} from './services.testkit.js';
import type { MissionViewRow } from '@/application/ports/view-rows.js';

/** Round-trip fixture: park one live tab, return the mission it landed in. */
const parkOne = async (): Promise<{
  missionId: string;
  h: Awaited<ReturnType<typeof makeServices>>;
}> => {
  const h = await makeServices();
  h.fakeTabs.seedLive(browserTabIdOf(1));
  await h.seed([liveTabPlan(1)]);
  const spy = h.ctxOf(1);
  await mustOk(h.services.park.parkTab({ browserTabId: browserTabIdOf(1) }, spy.ctx));
  const accepted = (await h.events()).find((e) => e.type === 'ParkIntentAccepted');
  const missionId = (accepted?.payload as { scope: { missionId: string } }).scope.missionId;
  return { missionId, h };
};

describe('E3-APP resume — §6.5 durable-accept-before-browser law', () => {
  it('accept is durable before windows.create; mapping + views complete the round trip', async () => {
    const { missionId, h } = await parkOne();

    // Ordering spy on the browser move.
    const origCreate = h.fakeWindows.create;
    let durableAcceptSeen = false;
    h.fakeWindows.create = async (spec) => {
      durableAcceptSeen = (await h.events()).some((e) => e.type === 'ResumeAccepted');
      return origCreate(spec);
    };
    const spy = h.ctxOf(11);
    const out = await mustOk(h.services.resume.resumeMission({ missionId, mode: 'full' }, spy.ctx));

    expect(durableAcceptSeen, 'browser ran before the durable accept — §6.5 violation').toBe(true);
    expect(out.restored).toBe(1);
    expect(out.moved).toBe(0);
    expect(spy.pendings).toEqual([`ResumeMission:${missionId}`]);

    // MissionResumed carries the ACTUAL mapping (created window + browser coords).
    const resumed = (await h.events()).find((e) => e.type === 'MissionResumed');
    const mapping = (
      resumed?.payload as {
        restoredMapping?: { windowId?: number; tabs?: { tabId: string; browserTabId?: number }[] };
      }
    ).restoredMapping;
    expect(mapping?.windowId).toBe(out.windowId);
    expect(mapping?.tabs).toEqual([
      { tabId: ledgeTabIdOf(1), browserTabId: expect.any(Number) as unknown as number },
    ]);

    // Views: mission live with a window binding; tab row LIVE with new coords.
    const mission = (await h.row('missions', missionId)) as unknown as MissionViewRow;
    expect(mission?.state).toBe('live');
    expect(mission?.windowBinding).toBe(out.windowId);
    const tabRow = await h.row('tabs', ledgeTabIdOf(1));
    expect(tabRow?.['state']).toBe('live');
    expect(typeof tabRow?.['browserTabId']).toBe('number');
    expect(tabRow?.['windowId']).toBe(out.windowId);
  });

  it('C7 open-check: a resend on an already-live mission answers without re-creating', async () => {
    const { missionId, h } = await parkOne();
    const first = await mustOk(
      h.services.resume.resumeMission({ missionId, mode: 'full' }, h.ctxOf(12).ctx),
    );
    const second = await mustOk(
      h.services.resume.resumeMission({ missionId, mode: 'full' }, h.ctxOf(13).ctx),
    );
    expect(second.windowId).toBe(first.windowId);
    expect(second.restored).toBe(0);
    expect(h.fakeWindows.createdLog().length).toBe(1);
    // And no duplicate terminal events rode the journal for the resend.
    const resumedCount = (await h.events()).filter((e) => e.type === 'MissionResumed').length;
    expect(resumedCount).toBe(1);
  });

  it('partial ⊆ mission legality: foreign tabIds are refused by the domain decider', async () => {
    const { missionId, h } = await parkOne();
    const foreign = await h.services.resume.resumeMission(
      { missionId, mode: 'partial', tabIds: [testId(88_002)] },
      h.ctxOf(14).ctx,
    );
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe('E_DOMAIN_LEGALITY');
    expect(h.fakeWindows.createdLog().length).toBe(0);

    // A genuine partial (subset) restores exactly the selected subset.
    const out = await mustOk(
      h.services.resume.resumeMission(
        { missionId, mode: 'partial', tabIds: [ledgeTabIdOf(1)] },
        h.ctxOf(15).ctx,
      ),
    );
    expect(out.restored).toBe(1);
  });

  it('mission-missing is the typed legality refusal (no orphan browser move)', async () => {
    const h = await makeServices();
    const r = await h.services.resume.resumeMission(
      { missionId: testId(88_003), mode: 'full' },
      h.ctxOf(16).ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_DOMAIN_LEGALITY');
    expect(h.fakeWindows.createdLog().length).toBe(0);
  });
});

describe('E3-APP restore — RestoreRecentlyClosed (C8)', () => {
  it("target 'new' forms a mission (provenance 'restore') and restores content rows", async () => {
    const h = await makeServices();
    // Externally-closed content rows: KEPT-side trash-travel keeps the row (content
    // law); the sealed-content limitation is the adr-noted projector growth.
    await h.seed([
      liveTabPlan(1),
      {
        type: 'EntityTrashed',
        payload: {
          kind: 'tab',
          id: ledgeTabIdOf(1),
          inverseAtom: { type: 'restore-tab', tabId: ledgeTabIdOf(1) },
          deletedAt: 1_785_400_000_050,
        },
      },
    ]);
    const spy = h.ctxOf(17);
    const out = await mustOk(
      h.services.resume.restoreRecentlyClosed({ ids: [ledgeTabIdOf(1)], target: 'new' }, spy.ctx),
    );
    expect(out.restored).toBe(1);
    const formed = (await h.events()).find((e) => e.type === 'MissionFormed');
    expect((formed?.payload as { provenance?: string }).provenance).toBe('restore');
    const tabRow = await h.row('tabs', ledgeTabIdOf(1));
    expect(tabRow?.['state']).toBe('live');
  });

  it('no restorable content is an honest zero, not an error sweep', async () => {
    const h = await makeServices();
    const out = await mustOk(
      h.services.resume.restoreRecentlyClosed(
        { ids: [testId(88_004)], target: 'new' },
        h.ctxOf(18).ctx,
      ),
    );
    expect(out.restored).toBe(0);
    expect((await h.events()).length).toBe(0);
  });
});
