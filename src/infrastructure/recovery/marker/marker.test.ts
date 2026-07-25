// E2-T07 crash-marker unit laws — ADR-007 §4 detection table, EES-R16
// disambiguation + copy paths, Blueprint §14.4/§6 card gating, EES §6
// StorageAreaPort hot-path law. The property suite holds the same laws against
// randomized marker histories; these fixtures pin every branch exactly.
import { describe, expect, it } from 'vitest';
import { createChromeStorageAreaAdapter } from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import { classifyBoot, copyKeyFor, MARKER_KEYS } from './index.js';
import { bootMarkerSequence, stampInstallMarker } from './lifecycle.js';
import { runBootSequence } from '../sequence.js';
import {
  acceptIntent,
  browserTabId,
  makeWorld,
  reconcile,
  withSabotage,
} from '../reconciler/testkit.js';
import type { BootCause } from './types.js';
import {
  makeAlive,
  makeBoot,
  makeClock,
  makeInstall,
  makeMarkerArea,
  runWake,
  stampInstall,
  VERSION_1,
  VERSION_2,
} from './testkit.js';
import type { Result, LedgeError } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok)
    throw new Error(`expected ok, got ${r.error.code} (${r.error.details?.['raw'] ?? ''})`);
  return r.value;
};

const seedMarkers = async (
  area: ReturnType<typeof makeMarkerArea>,
  markers: {
    alive?: ReturnType<typeof makeAlive> | string;
    install?: ReturnType<typeof makeInstall> | string;
    boot?: ReturnType<typeof makeBoot> | string;
  },
): Promise<void> => {
  if (markers.alive !== undefined) {
    unwrap(await area.port.sessionSet(MARKER_KEYS.alive, markers.alive));
  }
  if (markers.install !== undefined) {
    unwrap(await area.port.localSet(MARKER_KEYS.install, markers.install));
  }
  if (markers.boot !== undefined) {
    unwrap(await area.port.localSet(MARKER_KEYS.boot, markers.boot));
  }
};

describe('E2-T07 marker — classification table (ADR-007 §4 / EES-R16)', () => {
  it('M1: alive present ⇒ warm-recycle; exactly one session read, zero local reads', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    await seedMarkers(area, { alive: makeAlive({ bootSeq: 4 }) });
    const signal = unwrap(await runWake(area, VERSION_1, clock));
    expect(signal.cause).toBe('warm-recycle');
    expect(signal.abnormal).toBe(false);
    expect(signal.gaps).toEqual([]);
    expect(area.counts['session.get']).toBe(1); // ≤2ms hot law: one read gates
    expect(area.counts['local.get']).toBe(0);
    // The lifecycle still re-arms + re-stamps for the NEXT wake's evidence.
    const armed = area.raw('session')[MARKER_KEYS.alive] as { bootSeq: number };
    expect(armed.bootSeq).toBe(5);
    const boot = area.raw('local')[MARKER_KEYS.boot] as { bootSeq: number };
    expect(boot.bootSeq).toBe(5);
    expect(copyKeyFor(signal.cause, true)).toBeNull();
    expect(copyKeyFor(signal.cause, false)).toBeNull();
  });

  it('M2: virgin device ⇒ first-run; markers armed + stamped (bootSeq 1)', async () => {
    const area = makeMarkerArea();
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('first-run');
    expect(signal.abnormal).toBe(false);
    expect((area.raw('session')[MARKER_KEYS.alive] as { bootSeq: number }).bootSeq).toBe(1);
    const boot = area.raw('local')[MARKER_KEYS.boot] as { bootSeq: number; version: string };
    expect(boot.bootSeq).toBe(1);
    expect(boot.version).toBe(VERSION_1);
  });

  it('M3: install stamp, never booted ⇒ first-run (first-boot death collapses; never fabricated crash)', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, { install: makeInstall({ reason: 'install' }) });
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('first-run');
    expect(signal.evidence.installReason).toBe('install');
  });

  it('M4: extension update since last boot ⇒ updated; copy path msg.recovery.updated (lossRisk)', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, {
      install: makeInstall({ reason: 'update', version: VERSION_2, atTs: 200 }),
      boot: makeBoot({ version: VERSION_1, atTs: 100 }),
    });
    const signal = unwrap(await runWake(area, VERSION_2, makeClock()));
    expect(signal.cause).toBe('updated');
    expect(signal.abnormal).toBe(true);
    expect(signal.evidence.installedVersion).toBe(VERSION_2);
    expect(signal.evidence.lastBootVersion).toBe(VERSION_1);
    expect(copyKeyFor(signal.cause, true)).toBe('msg.recovery.updated');
    expect(copyKeyFor(signal.cause, false)).toBe('msg.heartbeat.recovered');
  });

  it('M5: chrome_update re-stamp at SAME version (newer ts) ⇒ updated', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, {
      install: makeInstall({ reason: 'chrome_update', version: VERSION_1, atTs: 200 }),
      boot: makeBoot({ version: VERSION_1, atTs: 100 }),
    });
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('updated');
  });

  it('M6 [R16 anchor]: update, normal boot at new build, THEN death ⇒ crashed (never “updated” twice)', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, {
      install: makeInstall({ reason: 'update', version: VERSION_2, atTs: 100 }),
      boot: makeBoot({ version: VERSION_2, atTs: 150 }), // boot AFTER the stamp
    });
    const signal = unwrap(await runWake(area, VERSION_2, makeClock()));
    expect(signal.cause).toBe('crashed');
    expect(copyKeyFor(signal.cause, true)).toBe('msg.recovery.crashed');
    expect(copyKeyFor(signal.cause, false)).toBe('msg.heartbeat.recovered');
  });

  it('M7: crash masked by an update that landed while closed ⇒ updated (R16 letter of law)', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, {
      install: makeInstall({ reason: 'update', version: VERSION_2, atTs: 200 }),
      boot: makeBoot({ version: VERSION_1, atTs: 150 }),
    });
    const signal = unwrap(await runWake(area, VERSION_2, makeClock()));
    expect(signal.cause).toBe('updated'); // loss stays covered: card gates on reconciler lossRisk
  });

  it('M8: stamp/boot timestamp tie (same version) ⇒ crashed (ties decide against updated)', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, {
      install: makeInstall({ reason: 'chrome_update', version: VERSION_1, atTs: 150 }),
      boot: makeBoot({ version: VERSION_1, atTs: 150 }),
    });
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('crashed');
  });

  it('M9: sessionless browser (FF parity) ⇒ undetectable; gaps disclose; no marker writes', async () => {
    const area = makeMarkerArea();
    area.dropSessionArea();
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('undetectable');
    expect(signal.gaps.join(',')).toContain('alive-marker-read:E_CAPABILITY');
    expect(area.counts['session.set']).toBe(0);
    expect(area.counts['local.set']).toBe(0);
    expect(area.counts['local.get']).toBe(0);
    expect(copyKeyFor(signal.cause, true)).toBeNull();
  });

  it('M10: session read failure ⇒ undetectable (storage failure ≠ absence), gap discloses', async () => {
    const area = makeMarkerArea();
    area.failNext('session.get', 'E_CAPABILITY_API');
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('undetectable');
    expect(signal.gaps.join(',')).toContain('alive-marker-read:E_CAPABILITY_API');
  });

  it('M11: unreadable markers are treated absent with precise gaps (ADR-033 tolerance)', async () => {
    const area = makeMarkerArea();
    await seedMarkers(area, { alive: 'garbage', install: 'garbage', boot: 'garbage' });
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('first-run'); // all three records unreadable ⇒ absent
    expect(signal.gaps.join(',')).toContain(`marker-unreadable:${MARKER_KEYS.alive}`);
    expect(signal.gaps.join(',')).toContain(`marker-unreadable:${MARKER_KEYS.install}`);
    expect(signal.gaps.join(',')).toContain(`marker-unreadable:${MARKER_KEYS.boot}`);
  });

  it('M12: copyKeyFor matrix — card keys only on lossRisk, heartbeat on clean-abnormal, null else', () => {
    const causes: BootCause[] = ['warm-recycle', 'first-run', 'updated', 'crashed', 'undetectable'];
    for (const cause of causes) {
      if (cause === 'updated') {
        expect(copyKeyFor(cause, true)).toBe('msg.recovery.updated');
        expect(copyKeyFor(cause, false)).toBe('msg.heartbeat.recovered');
      } else if (cause === 'crashed') {
        expect(copyKeyFor(cause, true)).toBe('msg.recovery.crashed');
        expect(copyKeyFor(cause, false)).toBe('msg.heartbeat.recovered');
      } else {
        expect(copyKeyFor(cause, true)).toBeNull();
        expect(copyKeyFor(cause, false)).toBeNull();
      }
    }
  });

  it('M13: marker write failures are hot-flag gaps, never boot failures', async () => {
    const area = makeMarkerArea();
    area.failNext('session.set', 'E_QUOTA');
    area.failNext('local.set', 'E_CAPABILITY_API');
    const signal = unwrap(await runWake(area, VERSION_1, makeClock()));
    expect(signal.cause).toBe('first-run'); // classification stands on what IS durable
    expect(signal.gaps.join(',')).toContain('alive-marker-arm:E_QUOTA');
    expect(signal.gaps.join(',')).toContain('boot-marker-stamp:E_CAPABILITY_API');
  });

  it('M14: stampInstallMarker writes a schemaV’d stamp; update overwrites install (R16 input)', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    unwrap(await stampInstall(area, 'install', VERSION_1, clock));
    clock.tick(50);
    unwrap(await stampInstall(area, 'update', VERSION_2, clock, VERSION_1));
    const raw = area.raw('local')[MARKER_KEYS.install] as Record<string, unknown>;
    expect(raw['schemaV']).toBe(1);
    expect(raw['reason']).toBe('update');
    expect(raw['previousVersion']).toBe(VERSION_1);
    expect(raw['version']).toBe(VERSION_2);
  });

  it('M15: bootSeq stays monotonic across a kill-at-arm gap (alive carries the sequence)', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    unwrap(await runWake(area, VERSION_1, clock)); // virgin wake: seq 1 everywhere
    // Kill at arm: alive advanced to seq 2, boot stamp left behind at seq 1.
    await seedMarkers(area, { alive: makeAlive({ bootSeq: 2, atTs: clock.now() + 1 }) });
    const before = (area.raw('local')[MARKER_KEYS.boot] as { bootSeq: number }).bootSeq;
    expect(before).toBe(1);
    const signal = unwrap(await runWake(area, VERSION_1, clock));
    expect(signal.cause).toBe('warm-recycle');
    expect((area.raw('local')[MARKER_KEYS.boot] as { bootSeq: number }).bootSeq).toBe(3);
  });

  it('M16: pure classifier is total — every hand-built image maps to exactly one cause', () => {
    const images = [
      {
        in: {
          sessionReadable: false,
          alive: null,
          aliveAbsentProven: false,
          install: null,
          boot: null,
        },
        out: 'undetectable',
      },
      {
        in: {
          sessionReadable: true,
          alive: makeAlive(),
          aliveAbsentProven: false,
          install: null,
          boot: null,
        },
        out: 'warm-recycle',
      },
      {
        in: {
          sessionReadable: true,
          alive: null,
          aliveAbsentProven: true,
          install: null,
          boot: null,
        },
        out: 'first-run',
      },
      {
        in: {
          sessionReadable: true,
          alive: null,
          aliveAbsentProven: true,
          install: makeInstall({ reason: 'update' }),
          boot: null,
        },
        out: 'updated',
      },
      {
        in: {
          sessionReadable: true,
          alive: null,
          aliveAbsentProven: true,
          install: null,
          boot: makeBoot(),
        },
        out: 'crashed',
      },
      {
        in: {
          sessionReadable: true,
          alive: null,
          aliveAbsentProven: true,
          install: makeInstall({ reason: 'shared_module_update', atTs: 300 }),
          boot: makeBoot({ atTs: 100 }),
        },
        out: 'updated',
      },
    ] as const;
    for (const { in: input, out } of images) expect(classifyBoot(input).cause).toBe(out);
  });
});

describe('E2-T07 marker — storage seam integration (adapter → lifecycle)', () => {
  it('S1: warm recycle across wakes within one browser session', async () => {
    const fake = createFakeChrome();
    const area = createChromeStorageAreaAdapter({ api: fake.storage });
    const clock = makeClock();
    const first = unwrap(await bootMarkerSequence({ area, version: VERSION_1, now: clock.now }));
    expect(first.cause).toBe('first-run');
    const second = unwrap(await bootMarkerSequence({ area, version: VERSION_1, now: clock.now }));
    expect(second.cause).toBe('warm-recycle');
  });

  it('S2: browser restart without update ⇒ crashed; restart after update stamp ⇒ updated (R16 fixtures)', async () => {
    const fake = createFakeChrome();
    const area = createChromeStorageAreaAdapter({ api: fake.storage });
    const clock = makeClock();
    // Boot at v1, then restart — the restart must read 'crashed'…
    unwrap(await bootMarkerSequence({ area, version: VERSION_1, now: clock.now }));
    fake.hooks.clearSessionArea();
    const crash = unwrap(await bootMarkerSequence({ area, version: VERSION_1, now: clock.now }));
    expect(crash.cause).toBe('crashed');
    expect(copyKeyFor(crash.cause, true)).toBe('msg.recovery.crashed');
    // …then an update stamp lands (onInstalled during the maintenance window),
    // the browser restarts to complete the update (session dies), and the v2
    // wake must read 'updated'. (An in-place update where the session SURVIVES
    // correctly classifies warm — nothing terminated; S1 covers that wake.)
    clock.tick(100);
    unwrap(
      await stampInstallMarker(
        area,
        { reason: 'update', previousVersion: VERSION_1 },
        VERSION_2,
        clock.now(),
      ),
    );
    fake.hooks.clearSessionArea();
    const updated = unwrap(await bootMarkerSequence({ area, version: VERSION_2, now: clock.now }));
    expect(updated.cause).toBe('updated');
    expect(copyKeyFor(updated.cause, true)).toBe('msg.recovery.updated');
  });

  it('S3: sessionless fake (FF parity) ⇒ undetectable end-to-end', async () => {
    const fake = createFakeChrome({ disableSession: true });
    const area = createChromeStorageAreaAdapter({ api: fake.storage });
    const signal = unwrap(
      await bootMarkerSequence({ area, version: VERSION_1, now: makeClock().now }),
    );
    expect(signal.cause).toBe('undetectable');
  });
});

describe('E2-T07 BootReport v1 — bootSignal section through runBootSequence', () => {
  it('B1: crash + clean journal ⇒ heartbeat copy (§14.4: no card without lossRisk)', async () => {
    const w = await makeWorld();
    const area = makeMarkerArea();
    await seedMarkers(area, { boot: makeBoot({ version: VERSION_1, atTs: 50 }) });
    const report = unwrap(
      await runBootSequence({ reconciler: w.deps, area: area.port, version: VERSION_1 }),
    );
    expect(report.schemaV).toBe(1);
    expect(report.bootSignal.cause).toBe('crashed');
    expect(report.outcome).toBe('clean');
    expect(report.lossRisk).toBe(false);
    expect(report.bootSignal.copyKey).toBe('msg.heartbeat.recovered');
  });

  it('B2: crash + deferred resolution ⇒ msg.recovery.crashed card copy (lossRisk)', async () => {
    const w = await makeWorld();
    const blocked = await acceptIntent(w, 1, 'ParkTab', { tabIds: [browserTabId(1)] });
    const sabotage = {
      scanTailFails: false,
      failAppendForIntent: { current: blocked },
      pendingFails: false,
    };
    const area = makeMarkerArea();
    await seedMarkers(area, { boot: makeBoot({ version: VERSION_1, atTs: 50 }) });
    const report = unwrap(
      await runBootSequence({
        reconciler: withSabotage(w, sabotage),
        area: area.port,
        version: VERSION_1,
      }),
    );
    expect(report.bootSignal.cause).toBe('crashed');
    expect(report.lossRisk).toBe(true); // deferred intent ⇒ risk is real
    expect(report.bootSignal.copyKey).toBe('msg.recovery.crashed');
  });

  it('B3: update + clean journal ⇒ updated cause, heartbeat copy; evidence embedded', async () => {
    const w = await makeWorld();
    const area = makeMarkerArea();
    await seedMarkers(area, {
      install: makeInstall({ reason: 'update', version: VERSION_2, atTs: 200 }),
      boot: makeBoot({ version: VERSION_1, atTs: 100 }),
    });
    const report = unwrap(
      await runBootSequence({ reconciler: w.deps, area: area.port, version: VERSION_2 }),
    );
    expect(report.bootSignal.cause).toBe('updated');
    expect(report.bootSignal.copyKey).toBe('msg.heartbeat.recovered');
    expect(report.bootSignal.evidence.installedVersion).toBe(VERSION_2);
    expect(report.bootSignal.evidence.lastBootVersion).toBe(VERSION_1);
  });

  it('B4: warm recycle ⇒ no ceremony (copyKey null), reconcile unaffected', async () => {
    const w = await makeWorld();
    const area = makeMarkerArea();
    await runWake(area, VERSION_1, makeClock()); // normal completed wake first
    const report = unwrap(
      await runBootSequence({ reconciler: w.deps, area: area.port, version: VERSION_1 }),
    );
    expect(report.bootSignal.cause).toBe('warm-recycle');
    expect(report.bootSignal.copyKey).toBeNull();
    expect(report.outcome).toBe('clean');
  });

  it('B5: reconciler direct-input path stays lawful (signal is explicit, never probed)', async () => {
    const w = await makeWorld();
    const report = unwrap(
      await reconcile(w, undefined, {
        cause: 'crashed',
        abnormal: true,
        evidence: {
          aliveSeen: false,
          installReason: 'install',
          installedVersion: VERSION_1,
          lastBootVersion: VERSION_1,
          installedAt: 1,
          lastBootAt: 2,
        },
        gaps: [],
      }),
    );
    expect(report.bootSignal.cause).toBe('crashed');
    expect(report.bootSignal.copyKey).toBe('msg.heartbeat.recovered'); // clean ⇒ no card
  });
});
