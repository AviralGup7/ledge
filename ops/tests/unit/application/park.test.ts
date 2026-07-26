// E3-APP · Park two-phase contract (§6.4, W4, ADR-002). Locking laws, not behaviors:
//  (1) snapshot is BUILT before any intent rides; (2) ack lands durable BEFORE the
//      browser mutation, and CommandAck accepted-pending publishes between them;
//  (3) browser-remove failure ⇒ honest ParkAborted terminal (never a silent strand);
//  (4) completion stamps KEPT per-tab (R1 post-Applied) and parks the mission view;
//  (5) C6 ParkAll rate law is an honest refusal, never a silent shed.
import { describe, expect, it } from 'vitest';
import { testId } from './services.testkit.js';
import {
  browserTabIdOf,
  browserWindowIdOf,
  ledgeTabIdOf,
  liveTabPlan,
  makeServices,
  mustOk,
} from './services.testkit.js';
import type { MissionViewRow } from '@/application/ports/view-rows.js';

const types = (events: readonly { readonly type: string }[]): readonly string[] =>
  events.map((e) => e.type);

describe('E3-APP park — two-phase write law (§6.4/ADR-002)', () => {
  it('snapshot-FIRST, ack durable, pending published, THEN the close, then completion', async () => {
    const h = await makeServices();
    const bt = browserTabIdOf(1);
    h.fakeTabs.seedLive(bt);
    await h.seed([liveTabPlan(1)]);

    // Ordering spy: when the close executes, the ack must already be durable and
    // the pending CommandAck already published (§3.5/ADR-002 invariant a).
    const origRemove = h.fakeTabs.remove;
    let removedAfterAck = false;
    let pendingBeforeRemove = 0;
    h.fakeTabs.remove = async (ids) => {
      const evs = types(await h.events());
      removedAfterAck = evs.includes('ParkIntentAccepted') && evs.includes('SnapshotTaken');
      pendingBeforeRemove = spy.pendings.length;
      return origRemove(ids);
    };
    const spy = h.ctxOf(1);
    const kept = await mustOk(h.services.park.parkTab({ browserTabId: bt }, spy.ctx));

    expect(kept.kept).toBe(ledgeTabIdOf(1));
    expect(removedAfterAck, 'browser close ran before the durable ack — W4 violation').toBe(true);
    expect(pendingBeforeRemove, 'CommandAck pending never published before the close').toBe(1);
    expect(h.fakeTabs.removedLog()).toEqual([[bt]]);

    // Event law: SnapshotTaken → MissionFormed(provenance 'park') → ParkIntentAccepted
    // → TabAssigned (per-tab KEPT stamp) → TabsParked terminal.
    const evs = await h.events();
    const seq = types(evs);
    expect(seq.indexOf('SnapshotTaken')).toBeLessThan(seq.indexOf('MissionFormed'));
    expect(seq.indexOf('MissionFormed')).toBeLessThan(seq.indexOf('ParkIntentAccepted'));
    expect(seq.indexOf('ParkIntentAccepted')).toBeLessThan(seq.indexOf('TabAssigned'));
    expect(seq.indexOf('TabAssigned')).toBeLessThan(seq.indexOf('TabsParked'));
    const formed = evs.find((e) => e.type === 'MissionFormed');
    expect((formed?.payload as { provenance?: string }).provenance).toBe('park');

    const accepted = evs.find((e) => e.type === 'ParkIntentAccepted');
    const intentId = (accepted?.payload as { intentId: string }).intentId;
    expect(spy.pendings).toEqual([intentId]);

    // Truth rows: tab KEPT + mission parked with the park intent stamp (R1).
    const missionId = (accepted?.payload as { scope: { missionId: string } }).scope.missionId;
    const tabRow = await h.row('tabs', ledgeTabIdOf(1));
    expect(tabRow?.['state']).toBe('kept');
    expect(tabRow?.['missionId']).toBe(missionId);
    const mission = (await h.row('missions', missionId)) as unknown as MissionViewRow;
    expect(mission?.state).toBe('parked');
    expect(mission?.parkIntentId).toBe(intentId);

    // §5 law: the snapshot part rows committed in the same txn A (hinge co-write).
    const sessionRows = await h.rows('sessions');
    expect(sessionRows.length).toBeGreaterThan(0);
    expect(sessionRows[0]?.['trigger']).toBe('park');

    // W4 ordering material: the snapshot build was proven BEFORE the ack commit.
    expect(h.fakeSnapshots.buildInputs().length).toBe(1);

    // Intent terminal: done exactly once.
    const intentRow = await h.row('intents', intentId);
    expect(intentRow?.['state']).toBe('done');

    // Progress law: stages are monotonic across the phases.
    const stages = spy.progressLog.map((p) => p.stage);
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
  });

  it('parks into an already-bound mission when the majority binding exists (no new mission)', async () => {
    const h = await makeServices();
    const m = testId(88_001);
    h.fakeTabs.seedLive(browserTabIdOf(1));
    await h.seed([
      liveTabPlan(1),
      {
        type: 'MissionFormed',
        payload: { missionId: m, name: 'bound', namedBy: 'user', tabIds: [ledgeTabIdOf(1)] },
      },
    ]);

    const kept = await mustOk(
      h.services.park.parkTab({ browserTabId: browserTabIdOf(1) }, h.ctxOf(2).ctx),
    );
    expect(kept.kept).toBe(ledgeTabIdOf(1));
    const evs = types(await h.events());
    // Exactly ONE MissionFormed (the seed): no formation event rides for bound targets.
    expect(evs.filter((t) => t === 'MissionFormed').length).toBe(1);
    const accepted = (await h.events()).find((e) => e.type === 'ParkIntentAccepted');
    expect((accepted?.payload as { scope: { missionId: string } }).scope.missionId).toBe(m);
  });

  it('browser-remove failure stamps an honest ParkAborted terminal (nothing vaulted)', async () => {
    const h = await makeServices();
    const bt = browserTabIdOf(3);
    h.fakeTabs.seedLive(bt);
    await h.seed([liveTabPlan(3)]);
    h.fakeTabs.failRemoveOnce('E_CAPABILITY_API');

    const r = await h.services.park.parkTab({ browserTabId: bt }, h.ctxOf(3).ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_CAPABILITY_API');

    const evs = types(await h.events());
    expect(evs).toContain('ParkAborted');
    expect(evs).not.toContain('TabsParked');
    const aborted = (await h.events()).find((e) => e.type === 'ParkAborted');
    expect((aborted?.payload as { liveLeftOpen: number }).liveLeftOpen).toBe(1);
    const intentId = (aborted?.payload as { intentId: string }).intentId;
    expect((await h.row('intents', intentId))?.['state']).toBe('aborted');
    // The tab row stays LIVE (abort-revert view law is the adr-noted conservative side).
    expect((await h.row('tabs', ledgeTabIdOf(3)))?.['state']).toBe('live');
  });

  it('unknown browser tab is the typed E_NOT_FOUND_TAB refresh signal', async () => {
    const h = await makeServices();
    const r = await h.services.park.parkTab({ browserTabId: 4242 }, h.ctxOf(4).ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_NOT_FOUND_TAB');
  });
});

describe('E3-APP park — scope variants and the C6 rate law', () => {
  it('parkWindow returns the §3.3 C5 shape (missionId, keptCount, briefQueued)', async () => {
    const h = await makeServices();
    h.fakeTabs.seedLive(browserTabIdOf(1));
    h.fakeTabs.seedLive(browserTabIdOf(2));
    await h.seed([liveTabPlan(1), liveTabPlan(2)]);
    const windowId = browserWindowIdOf(1); // fake-window law: one bucket for n=1,2
    const out = await mustOk(h.services.park.parkWindow({ windowId }, h.ctxOf(5).ctx));
    expect(out.keptCount).toBe(2);
    expect(out.briefQueued).toBe(false);
    expect(typeof out.missionId).toBe('string');
  });

  it('parkGroup carries the EES-R4 style record; empty group is a legality refusal', async () => {
    const h = await makeServices();
    const empty = await h.services.park.parkGroup({ groupId: 77 }, h.ctxOf(6).ctx);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe('E_DOMAIN_LEGALITY');

    h.fakeTabs.seedLive(browserTabIdOf(7));
    await h.seed([liveTabPlan(7, { groupId: 77 })]);
    const out = await mustOk(h.services.park.parkGroup({ groupId: 77 }, h.ctxOf(7).ctx));
    expect(out.keptCount).toBe(1);
    const styles = h.fakeSnapshots.buildInputs()[0]?.groupStyles ?? [];
    expect(styles.length).toBe(1);
    expect(styles[0]?.tabOrder).toEqual([ledgeTabIdOf(7)]);
  });

  it('ParkAll sweeps every live window and stamps the C6 rate law (honest refusal)', async () => {
    const h = await makeServices();
    h.fakeTabs.seedLive(browserTabIdOf(1));
    h.fakeTabs.seedLive(browserTabIdOf(2));
    h.fakeTabs.seedLive(browserTabIdOf(150));
    await h.seed([liveTabPlan(1), liveTabPlan(2), liveTabPlan(150)]);

    const first = await mustOk(h.services.park.parkAll({}, h.ctxOf(8).ctx));
    expect(first.keptCount).toBe(3);
    expect(first.missions).toBe(2); // two fake window buckets (n<100 and n=150)

    const second = await h.services.park.parkAll({}, h.ctxOf(9).ctx);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('E_RATE_LANESHED');
  });

  it('undo stack is untouched by park (park undo = resume; the stack law is locked)', async () => {
    const h = await makeServices();
    h.fakeTabs.seedLive(browserTabIdOf(1));
    await h.seed([liveTabPlan(1)]);
    await mustOk(h.services.park.parkTab({ browserTabId: browserTabIdOf(1) }, h.ctxOf(10).ctx));
    expect(await h.row('meta', 'undoStack')).toBeUndefined();
  });
});
