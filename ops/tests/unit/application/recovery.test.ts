// E6-T01 · W7 recovery service proofs (ops/tests/unit lane) — §14.4 announce gate,
// incident-slot merge law, GetBootReport DTO law, and the §5.9 put-back loop
// (per-mission Resume expansion, durable claim, settle law, leave-open on failure).
// Harness: REAL services over fake-indexeddb truth (services.testkit).
import { describe, expect, it } from 'vitest';
import type { BootReportInput, BootSignalInput } from '@/application/ports/recovery-boot.port.js';
import type { BootReportSlot } from '@/application/usecases/recovery.js';
import { META_BOOT_REPORT_KEY } from '@/application/usecases/recovery.js';
import type { WindowsPort } from '@/application/ports/windows.port.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import {
  browserTabIdOf,
  browserWindowIdOf,
  ledgeTabIdOf,
  makeServices,
  mustOk,
  testId,
  type SeedPlan,
  type ServicesHarness,
} from './services.testkit.js';

const WALL = 1_785_400_000_000;
const MISSION_A = testId(8_100_001);
const MISSION_B = testId(8_100_002);

const signalOf = (over: Partial<BootSignalInput> = {}): BootSignalInput => ({
  abnormal: false,
  cause: 'warm-recycle',
  copyKey: null,
  gaps: [],
  ...over,
});

const reportOf = (over: Partial<BootReportInput> = {}): BootReportInput => ({
  outcome: 'clean',
  lossRisk: false,
  crossCheck: 'applied',
  bootTs: WALL,
  bootSignal: signalOf(),
  resolutions: [],
  gaps: [],
  ...over,
});

const crashReport = (over: Partial<BootReportInput> = {}): BootReportInput =>
  reportOf({
    lossRisk: true,
    outcome: 'recovered',
    bootSignal: signalOf({
      abnormal: true,
      cause: 'crashed',
      copyKey: 'msg.recovery.crashed',
    }),
    ...over,
  });

const liveTabPlan = (n: number): SeedPlan => ({
  type: 'TabObserved',
  payload: {
    ledgeTabId: ledgeTabIdOf(n),
    url: `https://rt-${n}.test/x`,
    title: `rt-${n}`,
    domain: `rt-${n}.test`,
    browserTabId: browserTabIdOf(n),
    windowId: browserWindowIdOf(n),
    urlCanon: `rt-${n}.test/x`,
    canonRulesV: 1,
    ts: WALL + n,
  },
});

const formedPlan = (missionId: string, tabNs: readonly number[]): SeedPlan => ({
  type: 'MissionFormed',
  payload: {
    missionId,
    name: 'Recovery mission',
    namedBy: 'user',
    tabIds: tabNs.map(ledgeTabIdOf),
    provenance: 'test',
  },
});

const seedLiveMission = async (
  h: ServicesHarness,
  missionId: string,
  tabNs: readonly number[],
): Promise<void> => {
  await h.seed([...tabNs.map(liveTabPlan), formedPlan(missionId, tabNs)]);
};

const slotOf = async (h: ServicesHarness): Promise<BootReportSlot | undefined> => {
  const row = await h.row('meta', META_BOOT_REPORT_KEY);
  return row?.['value'] as BootReportSlot | undefined;
};

const writeSlot = async (h: ServicesHarness, slot: BootReportSlot): Promise<void> => {
  const r = await h.engine.txn(['meta'], 'readwrite', async (tx) => {
    await tx.table('meta').put({ key: META_BOOT_REPORT_KEY, value: slot });
  });
  if (!r.ok) throw new Error(`slot write failed: ${r.error.code}`);
};

const failingWindows: WindowsPort = {
  list: () => Promise.resolve(ok([])),
  create: () => Promise.resolve(err(ledgeError('E_CAPABILITY', { op: 'windows.create' }))),
  remove: () => Promise.resolve(ok(undefined)),
  focus: () => Promise.resolve(ok(undefined)),
  onEvents: () => ({ close: () => undefined }),
};

describe('E6-T01 recordBoot — §14.4 announce gate + incident-slot merge law', () => {
  it('announces nothing for a warm recycle and writes no copy path', async () => {
    const h = await makeServices();
    const answer = await mustOk(h.services.recovery.recordBoot(reportOf()));
    expect(answer.announce).toBe(false);
    expect(answer.severity).toBeNull();
    expect(answer.cardWanted).toBe(false);
    // Id-less view stays silent for non-incident slots.
    expect(await mustOk(h.services.recovery.getBootReport({}))).toBeNull();
  });

  it('announces loss-risk on crash-with-risk and the view is pending with scope', async () => {
    const h = await makeServices();
    await seedLiveMission(h, MISSION_A, [1, 2]);
    const answer = await mustOk(h.services.recovery.recordBoot(crashReport()));
    expect(answer.announce).toBe(true);
    expect(answer.severity).toBe('loss-risk');
    expect(answer.cardWanted).toBe(true);

    const view = await mustOk(h.services.recovery.getBootReport({}));
    expect(view).not.toBeNull();
    expect(view?.pending).toBe(true);
    expect(view?.severity).toBe('loss-risk');
    expect(view?.copyKey).toBe('msg.recovery.crashed');
    expect(view?.scope).toEqual({ tabsRecoverable: 2, missionsAffected: 1 });
    // Seeds run seq 1..3: the MissionFormed membership patch is the last activity.
    expect(view?.asOf).toBe(WALL + 3);
    expect(view?.disclosure.map((d) => d.token)).toContain('journal-truncate');
    // Explicit-id demand path answers the same incident.
    const demand = await mustOk(
      h.services.recovery.getBootReport({ bootReportId: answer.bootReportId }),
    );
    expect(demand?.bootReportId).toBe(answer.bootReportId);
  });

  it('announces clean-abnormal on updated-cause without loss-risk (chip, no card)', async () => {
    const h = await makeServices();
    const answer = await mustOk(
      h.services.recovery.recordBoot(
        reportOf({
          bootSignal: signalOf({
            abnormal: true,
            cause: 'updated',
            copyKey: 'msg.heartbeat.recovered',
          }),
        }),
      ),
    );
    expect(answer.announce).toBe(true);
    expect(answer.severity).toBe('clean-abnormal');
    expect(answer.cardWanted).toBe(false);
    const view = await mustOk(h.services.recovery.getBootReport({}));
    expect(view?.pending).toBe(false);
    expect(view?.cause).toBe('updated');
  });

  it('merge law: a pending incident is never clobbered by a warm recycle', async () => {
    const h = await makeServices();
    const first = await mustOk(h.services.recovery.recordBoot(crashReport()));
    const merged = await mustOk(h.services.recovery.recordBoot(reportOf()));
    expect(merged.announce).toBe(false);
    expect(merged.bootReportId).toBe(first.bootReportId);
    expect(merged.cardWanted).toBe(true);
    const view = await mustOk(h.services.recovery.getBootReport({}));
    expect(view?.bootReportId).toBe(first.bootReportId);
    expect(view?.pending).toBe(true);
  });

  it('merge law: a new incident supersedes, a settled slot retires on clean boots', async () => {
    const h = await makeServices();
    const first = await mustOk(h.services.recovery.recordBoot(crashReport()));
    // Settle by hand (the restore suite proves the real path).
    const slot = await slotOf(h);
    if (slot === undefined) throw new Error('slot must exist');
    await writeSlot(h, { ...slot, settledAt: WALL + 9_000 });
    const clean = await mustOk(h.services.recovery.recordBoot(reportOf()));
    expect(clean.bootReportId).not.toBe(first.bootReportId);
    expect(clean.announce).toBe(false);
  });

  it('disclosure receipts: tokens + counts derive from report facts', async () => {
    const h = await makeServices();
    await mustOk(
      h.services.recovery.recordBoot(
        crashReport({
          resolutions: [
            { disposition: 'aborted-conservative' },
            { disposition: 'aborted-conservative' },
            { disposition: 'deferred' },
          ],
          crossCheck: 'degraded-unavailable',
          bootSignal: signalOf({
            abnormal: true,
            cause: 'crashed',
            copyKey: 'msg.recovery.crashed',
            gaps: ['marker-unreadable:boot'],
          }),
        }),
      ),
    );
    const view = await mustOk(h.services.recovery.getBootReport({}));
    const byToken = new Map(view?.disclosure.map((d) => [d.token, d.count]));
    expect(byToken.get('journal-truncate')).toBe(1);
    expect(byToken.get('left-open')).toBe(2);
    expect(byToken.get('deferred')).toBe(1);
    expect(byToken.get('crosscheck-degraded')).toBe(1);
    expect(byToken.get('marker-gap')).toBe(1);
  });
});

describe('E6-T01 restoreBootSession — §5.9 put-back (per-mission Resume expansion)', () => {
  it('restores every live mission: accept band before browser move, then completion', async () => {
    const h = await makeServices();
    await seedLiveMission(h, MISSION_A, [1, 2]);
    await seedLiveMission(h, MISSION_B, [3]);
    const boot = await mustOk(h.services.recovery.recordBoot(crashReport()));

    const ctx = h.ctxOf(1);
    const out = await mustOk(
      h.services.recovery.restoreBootSession({ bootReportId: boot.bootReportId }, ctx.ctx),
    );
    expect(out).toEqual({ missionsRestored: 2, tabsRestored: 3, disclosure: [] });

    // One window per mission; exactly the FIRST is focused (calm arrival law).
    const created = h.fakeWindows.createdLog();
    expect(created.length).toBe(2);
    expect(created.filter((w) => w.focused === true).length).toBe(1);

    // Durable truth: ResumeAccepted BEFORE MissionResumed per mission, in journal order.
    const types = (await h.events()).map((e) => e.type);
    const resumeIdx = types.indexOf('ResumeAccepted');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(types.indexOf('MissionResumed')).toBeGreaterThan(resumeIdx);
    expect(types.filter((t) => t === 'ResumeAccepted').length).toBe(2);
    expect(types.filter((t) => t === 'MissionResumed').length).toBe(2);
    expect(ctx.pendings.length).toBe(2);

    // Settle law: the incident retires; a resend answers the idempotent zero.
    const slot = await slotOf(h);
    expect(slot?.settledAt).not.toBeNull();
    expect(slot?.restoringCid).toBeNull();
    const replay = await mustOk(
      h.services.recovery.restoreBootSession({ bootReportId: boot.bootReportId }, h.ctxOf(2).ctx),
    );
    expect(replay).toEqual({
      missionsRestored: 0,
      tabsRestored: 0,
      disclosure: ['already-restored'],
    });
  });

  it('skips missions whose recorded window is still open (browser-reality resend guard)', async () => {
    const h = await makeServices();
    await seedLiveMission(h, MISSION_A, [1]);
    const boot = await mustOk(h.services.recovery.recordBoot(crashReport()));
    // Browser reality: the recorded windowBinding still holds live tabs.
    const slot = await slotOf(h);
    if (slot === undefined) throw new Error('slot must exist');
    const binding = browserWindowIdOf(1);
    h.fakeTabs.seedLive(9_999, { windowId: binding });
    const mission = await h.row('missions', MISSION_A);
    const stamped = { ...mission, windowBinding: binding };
    const fix = await h.engine.txn(['missions'], 'readwrite', async (tx) => {
      await tx.table('missions').put(stamped);
    });
    if (!fix.ok) throw new Error(`mission stamp failed: ${fix.error.code}`);

    const out = await mustOk(
      h.services.recovery.restoreBootSession({ bootReportId: boot.bootReportId }, h.ctxOf(1).ctx),
    );
    expect(out.missionsRestored).toBe(0);
    expect(out.disclosure).toEqual(['already-open', 'nothing-live']);
    expect(h.fakeWindows.createdLog().length).toBe(0);
    // A clean skip is not a failure — the incident settles.
    expect((await slotOf(h))?.settledAt).not.toBeNull();
  });

  it('leave-open on browser failure: failure disclosed, incident stays pending, claim freed', async () => {
    const h = await makeServices({ windows: failingWindows });
    await seedLiveMission(h, MISSION_A, [1, 2]);
    const boot = await mustOk(h.services.recovery.recordBoot(crashReport()));

    const out = await mustOk(
      h.services.recovery.restoreBootSession({ bootReportId: boot.bootReportId }, h.ctxOf(1).ctx),
    );
    expect(out.missionsRestored).toBe(0);
    expect(out.tabsRestored).toBe(0);
    expect(out.disclosure).toEqual(['restore-failed']);
    const slot = await slotOf(h);
    expect(slot?.settledAt).toBeNull(); // pending — retry is lawful
    expect(slot?.restoringCid).toBeNull(); // claim freed for the retry
    // The durable accept band was still stamped before the failed browser move.
    const types = (await h.events()).map((e) => e.type);
    expect(types).toContain('ResumeAccepted');
    expect(types).not.toContain('MissionResumed');
  });

  it('refusals: missing slot, stale id, non-incident slot, in-flight claim', async () => {
    const h = await makeServices();
    const ctx = h.ctxOf(1).ctx;
    const missing = await h.services.recovery.restoreBootSession(
      { bootReportId: testId(8_200_001) },
      ctx,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.details?.['reason']).toBe('boot-report-missing');

    await mustOk(h.services.recovery.recordBoot(crashReport()));
    const stale = await h.services.recovery.restoreBootSession(
      { bootReportId: testId(8_200_002) },
      h.ctxOf(2).ctx,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.details?.['reason']).toBe('boot-report-stale');

    const first = await mustOk(h.services.recovery.recordBoot(crashReport()));
    const slot = await slotOf(h);
    if (slot === undefined) throw new Error('slot must exist');
    await writeSlot(h, { ...slot, restoringCid: 'cid-somewhere-else' });
    const claimed = await h.services.recovery.restoreBootSession(
      { bootReportId: first.bootReportId },
      h.ctxOf(3).ctx,
    );
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.error.details?.['reason']).toBe('restore-in-flight');

    // Non-incident slot: announce-less, restore would fabricate work — refused.
    const h2 = await makeServices();
    const warm = await mustOk(h2.services.recovery.recordBoot(reportOf()));
    const refused = await h2.services.recovery.restoreBootSession(
      { bootReportId: warm.bootReportId },
      h2.ctxOf(1).ctx,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details?.['reason']).toBe('nothing-to-restore');
  });
});
