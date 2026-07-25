// E2-T06 boot reconciler — unit laws (ADR-011, EES §2.13, EES §10-R2, Blueprint §5).
import { describe, expect, it } from 'vitest';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import {
  acceptIntent,
  browserTabId,
  decisionProjection,
  ledgeTabId,
  makeWorld,
  missionId,
  observeThenClose,
  parkAborted,
  reconcile,
  tabClosedExternal,
  tabsParked,
  tabObserved,
  withSabotage,
  type ReconcileWorld,
} from './testkit.js';
import { RECONCILE_REPORT_SCHEMA_V } from './types.js';

const unwrap = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(`unexpected err: ${JSON.stringify(r.error)}`);
  return r.value;
};

describe('E2-T06 boot reconciler — unit laws', () => {
  it('R1: a spotless boot still produces a BootReport — clean, no loss-risk (§2.13)', async () => {
    const w = await makeWorld();
    const report = unwrap(await reconcile(w));
    expect(report.schemaV).toBe(RECONCILE_REPORT_SCHEMA_V);
    expect(report.outcome).toBe('clean');
    expect(report.lossRisk).toBe(false);
    expect(report.intentsExamined).toBe(0);
    expect(report.resolutions).toEqual([]);
    expect(report.journalProbe.ok).toBe(true);
    expect(report.crossCheck).toBe('degraded-unavailable');
    expect(report.gaps).toContain('sessions-crosscheck-unavailable');
  });

  it('R2: pending park + ZERO proof ⇒ conservative abort — leave-open + disclose', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1), browserTabId(2)] });
    const before = (await w.readAll()).length;

    const report = unwrap(await reconcile(w));
    expect(report.outcome).toBe('reconciled');
    expect(report.lossRisk).toBe(false); // nothing executed pre-crash: no risk to content
    const [res] = report.resolutions;
    expect(res?.intentId).toBe(id);
    expect(res?.disposition).toBe('aborted-conservative');
    expect(res?.stale).toBe('lost-in-crash');
    expect(res?.liveLeftOpen).toBe(2);

    const row = await w.row(id);
    expect(row.state).toBe('aborted');
    const events = await w.readAll();
    expect(events.length).toBe(before + 1);
    const abortEnv = events.at(-1);
    expect(abortEnv?.envelope.type).toBe('ParkAborted');
    expect((abortEnv?.envelope.payload as Record<string, unknown>)['intentId']).toBe(id);
    expect((abortEnv?.envelope.payload as Record<string, unknown>)['liveLeftOpen']).toBe(2);
    // Stream law: resolution events chain contiguously onto the fixture stream.
    expect(abortEnv?.seq).toBe(before + 1);
  });

  it('R3: §10-R2 full external-close coverage ⇒ completed-evidence, secured counted once', async () => {
    const w = await makeWorld();
    const tabs = [1, 2, 3];
    const id = await acceptIntent(w, 1, 'ParkAll', { tabIds: tabs.map(browserTabId) });
    await observeThenClose(w, tabs);

    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('completed-evidence');
    expect(res?.stale).toBe('externally-closed');
    expect(res?.securedCounted).toBe(3);
    expect([...(res?.evidenceTabs ?? [])].sort((a, b) => a - b)).toEqual(tabs.map(browserTabId));
    expect(report.evidence.coveredOnce).toBe(3);
    expect(report.lossRisk).toBe(false);

    const row = await w.row(id);
    expect(row.state).toBe('done');
    const events = await w.readAll();
    const parked = events.filter((e) => e.envelope.type === 'TabsParked');
    expect(parked).toHaveLength(1);
    expect((parked[0]?.envelope.payload as Record<string, unknown>)['secured']).toBe(3);
  });

  it('R4: §10-R2 PARTIAL coverage ⇒ conservative abort (never completes unprovable closes)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkAll', {
      tabIds: [browserTabId(1), browserTabId(2), browserTabId(3)],
    });
    await observeThenClose(w, [1, 3]); // tab 2's fate is unknown — forever

    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('aborted-conservative');
    expect(res?.reason).toBe('external-close-evidence-partial');
    expect(res?.liveLeftOpen).toBe(1);
    expect(res?.evidenceTabs).toHaveLength(2);
    expect(report.lossRisk).toBe(true); // ambiguous world ⇒ §14.4 card input

    const row = await w.row(id);
    expect(row.state).toBe('aborted');
    const events = await w.readAll();
    expect(events.filter((e) => e.envelope.type === 'TabsParked')).toHaveLength(0);
    const aborts = events.filter((e) => e.envelope.type === 'ParkAborted');
    expect(aborts).toHaveLength(1);
    expect((aborts[0]?.envelope.payload as Record<string, unknown>)['liveLeftOpen']).toBe(1);
  });

  it('R5: torn complete (terminal durable, row pending) ⇒ completed-safe semantic restamp', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    await observeThenClose(w, [1]);
    // Executor appended the completion event but the hinged row-flip never landed.
    await w.append([tabsParked(w, id, 1)]);
    const preCount = (await w.readAll()).length;

    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('completed-safe');
    expect(res?.stale).toBe('stable-lag');

    const row = await w.row(id);
    expect(row.state).toBe('done');
    const parked = (await w.readAll()).filter((e) => e.envelope.type === 'TabsParked');
    // Original (executor's) + one semantic restamp — SAME intentId/key family;
    // consumers dedupe by registry idempotentBy:intentId. Count stays 2 forever.
    expect(parked).toHaveLength(2);
    expect(parked[0]?.envelope.eventId).not.toBe(parked[1]?.envelope.eventId);
    expect((parked[1]?.envelope.payload as Record<string, unknown>)['intentId']).toBe(id);
    expect((await w.readAll()).length).toBe(preCount + 1);
  });

  it('R6: torn ABORT terminal converges to aborted (abort wins — cannot destroy content)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    await w.append([parkAborted(w, id, 1)]);

    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('completed-safe');
    const row = await w.row(id);
    expect(row.state).toBe('aborted');
    const aborts = (await w.readAll()).filter((e) => e.envelope.type === 'ParkAborted');
    expect(aborts).toHaveLength(2); // executor's durable row + semantic restamp
  });

  it('R7: resume intent without proof ⇒ deferred + retry-counted + disclosed (never guessed)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ResumeMission', { missionId: missionId(1) });

    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('deferred');
    expect(res?.reason).toBe('defer:no-abort-row');
    expect(report.lossRisk).toBe(true);
    const row = await w.row(id);
    expect(row.state).toBe('intent'); // still pending — next boot re-examines
    expect(row.retryCount).toBe(1);
    expect(
      (await w.readAll()).filter((e) => e.envelope.type !== 'ParkIntentAccepted'),
    ).toHaveLength(0);
  });

  it('R8: unknown kind ⇒ deferred with unmanaged-kind reason (policies never guess)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'NuclearOption', { tabIds: [browserTabId(1)] });
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('deferred');
    expect(res?.reason).toBe('defer:unmanaged-kind');
    expect((await w.row(id)).state).toBe('intent');
  });

  it('R9: R2 scope filter — closes OUTSIDE the intent refs never count as its evidence', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    // Closes land AFTER the acceptance (in-flight) but for FOREIGN tabs only.
    await observeThenClose(w, [2, 3]);
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('aborted-conservative');
    expect(res?.evidenceTabs).toEqual([]);
    expect(res?.liveLeftOpen).toBe(1);
    expect(report.evidence.coveredOnce).toBe(0);
    expect((await w.row(id)).state).toBe('aborted');
  });

  it('R20 [regression B20]: closes BEFORE the acceptance are temporal noise — §2.13 command→observation order', async () => {
    const w = await makeWorld();
    // The user closed tab 1 YESTERDAY; today a park command targets its (now
    // chrome-reused) id. The stale close must NOT prove this intent — only an
    // observation strictly after the acceptance is completion evidence.
    await observeThenClose(w, [1]);
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('aborted-conservative');
    expect(res?.evidenceTabs).toEqual([]);
    expect(res?.liveLeftOpen).toBe(1);
    expect((await w.row(id)).state).toBe('aborted');

    // …and a close strictly AFTER the acceptance does prove it (guard asymmetry).
    const w2 = await makeWorld();
    const id2 = await acceptIntent(w2, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    await observeThenClose(w2, [1]);
    const report2 = unwrap(await reconcile(w2));
    const [res2] = report2.resolutions;
    expect(res2?.disposition).toBe('completed-evidence');
    expect(res2?.evidenceTabs).toEqual([browserTabId(1)]);
    void id2;
  });

  it('R10: reconcile is idempotent — a second boot finds nothing to do (recovery law)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkAll', { tabIds: [browserTabId(1), browserTabId(2)] });
    await observeThenClose(w, [1, 2]);
    unwrap(await reconcile(w));
    const settledEvents = (await w.readAll()).length;

    const second = unwrap(await reconcile(w));
    expect(second.outcome).toBe('clean');
    expect(second.resolutions).toEqual([]);
    expect(second.lossRisk).toBe(false);
    expect((await w.readAll()).length).toBe(settledEvents); // zero new bytes
    expect((await w.row(id)).state).toBe('done');
  });

  it('R11: liveTabsProbe supplies leave-open counts when scope refs are unreadable', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkWindow', { windowId: 3 }); // refs unreadable
    const deps = { ...w.deps, liveTabsProbe: () => Promise.resolve(ok(7)) };
    const report = unwrap(await reconcile(w, deps));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('aborted-conservative');
    expect(res?.liveLeftOpen).toBe(7);
    expect(res?.reason).toBe('completion-unprovable:scope-refs-unreadable');
    expect((await w.row(id)).state).toBe('aborted');
  });

  it('R12: crossCheck seam — candidates applied when wired, degraded when not', async () => {
    const w = await makeWorld();
    const withProbe = { ...w.deps, crossCheck: () => Promise.resolve(ok(['ses:1'])) };
    const applied = unwrap(await reconcile(w, withProbe));
    expect(applied.crossCheck).toBe('applied');

    const failing = {
      ...w.deps,
      crossCheck: () =>
        Promise.resolve(err(ledgeError('E_CAPABILITY_API', { raw: 'sessions-down' }))),
    };
    const degraded = unwrap(await reconcile(w, failing));
    expect(degraded.crossCheck).toBe('degraded-unavailable');
    expect(degraded.gaps.some((g) => g.startsWith('cross-check:'))).toBe(true);
  });

  it('R13: projection catch-up converges read models + watermark only moves forward', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkAll', { tabIds: [browserTabId(1)] });
    await observeThenClose(w, [1]);
    const before = unwrap(await w.projections.status());
    const wmBefore = Math.max(0, ...before.views.flatMap((v) => v.watermarks.map((x) => x.seq)));

    const report = unwrap(await reconcile(w));
    expect(report.projections).not.toBeNull();
    expect(report.projections?.applied).toBeGreaterThanOrEqual(2); // closes + TabsParked
    expect(report.projections?.watermarkTo).toBeGreaterThanOrEqual(wmBefore);
    const after = unwrap(await w.projections.status());
    const wmAfter = Math.max(...after.views.flatMap((v) => v.watermarks.map((x) => x.seq)));
    expect(wmAfter).toBe((await w.readAll()).at(-1)?.seq);
    void id;
  });

  it('R14: degraded probe ⇒ recovered posture, nothing written, loss-risk disclosed', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    const before = (await w.readAll()).length;
    const deps = withSabotage(w, {
      scanTailFails: true,
      failAppendForIntent: { current: null },
      pendingFails: false,
    });
    const report = unwrap(await reconcile(w, deps));
    expect(report.outcome).toBe('recovered');
    expect(report.journalProbe.ok).toBe(false);
    expect(report.lossRisk).toBe(true);
    expect(report.resolutions).toEqual([]);
    expect((await w.readAll()).length).toBe(before); // NO writes onto unverified truth
    expect((await w.row(id)).state).toBe('intent');
  });

  it('R15: pending-scan failure ⇒ recovered posture (never reconciles blind)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    const deps = withSabotage(w, {
      scanTailFails: false,
      failAppendForIntent: { current: null },
      pendingFails: true,
    });
    const report = unwrap(await reconcile(w, deps));
    expect(report.outcome).toBe('recovered');
    expect(report.lossRisk).toBe(true);
    expect((await w.row(id)).state).toBe('intent');
  });

  it('R16 [regression B19]: resolution-write stall must NOT burn stream seqs — same boot heals the rest', async () => {
    const w = await makeWorld();
    const blocked = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    await observeThenClose(w, [1]);
    const fine = await acceptIntent(w, 2, 'ParkTab', { tabIds: [browserTabId(2)] });
    await observeThenClose(w, [2]);

    const deps = withSabotage(w, {
      scanTailFails: false,
      failAppendForIntent: { current: blocked },
      pendingFails: false,
    });
    const report = unwrap(await reconcile(w, deps));
    expect(report.outcome).toBe('reconciled');
    const byIntent = new Map(report.resolutions.map((r) => [r.intentId, r]));
    expect(byIntent.get(blocked)?.disposition).toBe('deferred');
    expect(byIntent.get(blocked)?.reason).toBe('defer:resolution-write-failed');
    expect(byIntent.get(fine)?.disposition).toBe('completed-evidence');
    expect(report.lossRisk).toBe(true); // a deferred intent exists
    expect((await w.row(blocked)).state).toBe('intent');
    expect((await w.row(fine)).state).toBe('done');
    // Retry loop law: a clean second boot heals the stalled intent.
    const again = unwrap(await reconcile(w));
    expect(again.resolutions.find((r) => r.intentId === blocked)?.disposition).toBe(
      'completed-evidence',
    );
    expect((await w.row(blocked)).state).toBe('done');
  });

  it('R22: §10-R2 dedupe law — duplicate refs in a hostile scope count exactly once', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkAll', {
      tabIds: [browserTabId(1), browserTabId(1), browserTabId(2)],
    });
    await observeThenClose(w, [1, 2]);
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('completed-evidence');
    expect(res?.securedCounted).toBe(2); // NOT 3 — (intentId, browserTabId) is the key
    expect(res?.evidenceTabs?.length).toBe(2);
    expect((await w.row(id)).state).toBe('done');
  });

  it('R21: type-family law — a torn TabsParked naming an UNDO intent proves nothing (defer)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'Undo', { actionId: 'a1' });
    // Foreign/corrupt history: a park terminal references this intentId.
    await w.append([tabsParked(w, id, 3)]);
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('deferred');
    expect(res?.reason).toBe('defer:unmanaged-kind');
    expect((await w.row(id)).state).toBe('intent');
  });

  it('R17: report determinism — independent reconcilers reach identical decisions', async () => {
    const build = async (): Promise<{ w: ReconcileWorld; gapless: Record<string, unknown>[] }> => {
      const w = await makeWorld();
      await acceptIntent(w, 1, 'ParkAll', { tabIds: [browserTabId(1), browserTabId(2)] });
      await observeThenClose(w, [1]);
      await acceptIntent(w, 2, 'ResumeMission', { missionId: missionId(9) });
      const report = unwrap(await reconcile(w));
      return { w, gapless: report.resolutions.map(decisionProjection) };
    };
    const a = await build();
    const b = await build();
    expect(a.gapless).toEqual(b.gapless);
    // Streams match semantically too (event ids differ by world; payloads do not).
    const payloads = (w: ReconcileWorld) =>
      w.readAll().then((es) => es.map((e) => ({ t: e.envelope.type, p: e.envelope.payload })));
    expect(await payloads(a.w)).toEqual(await payloads(b.w));
  });

  it('R18: ledgeTabId trail link — closes only count when identity was observed (§2.1)', async () => {
    const w = await makeWorld();
    const id = await acceptIntent(w, 1, 'ParkAll', { tabIds: [browserTabId(1)] });
    // Close event for a ledgeTabId that was NEVER observed: identity link missing ⇒
    // the close cannot prove anything (defensive vs corrupt/foreign streams).
    await w.append([tabClosedExternal(w, 1)]);
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('aborted-conservative');
    expect(res?.evidenceTabs).toEqual([]);
    expect((await w.row(id)).state).toBe('aborted');
  });

  it('R19: ledgeTabId identity seam — evidence keys browserTabId via TabObserved chain', async () => {
    const w = await makeWorld();
    await w.append([tabObserved(w, 5)]);
    await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(5)] });
    await w.append([tabClosedExternal(w, 5)]);
    const report = unwrap(await reconcile(w));
    const [res] = report.resolutions;
    expect(res?.disposition).toBe('completed-evidence');
    expect(res?.evidenceTabs).toEqual([browserTabId(5)]);
    expect(res?.securedCounted).toBe(1);
    void ledgeTabId;
  });
});
