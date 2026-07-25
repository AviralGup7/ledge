// E2-T07 chaos — crash-marker kill-point matrix. Every boot.* point enumerated
// in ops/chaos/points.txt leaves the device in a torn marker state; fixtures
// build exactly that durable image (arm without stamp, stamp without arm) and
// assert the NEXT wake classifies lawfully, self-heals, and never fabricates a
// crash or an update the evidence cannot prove.
//
// Also the flow-partition CONSTITUTION: the file is exactly the union of this
// suite's points and the reconciler suite's points, disjoint — an orphan line
// in points.txt, a point owned by nobody, or a point owned twice all fail CI.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { copyKeyFor, MARKER_KEYS } from './index.js';
import { RECONCILER_KILL_POINTS } from '../reconciler/testkit.js';
import {
  BOOT_MARKER_KILL_POINTS,
  makeAlive,
  makeBoot,
  makeClock,
  makeMarkerArea,
  runWake,
  stampInstall,
  VERSION_1,
  VERSION_2,
} from './testkit.js';
import type { Result, LedgeError } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

const pointsFile = (): string[] =>
  readFileSync(new URL('../../../../ops/chaos/points.txt', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

describe('E2-T07 chaos — kill-point constitution (flow partition is exact)', () => {
  it('ops/chaos/points.txt == reconciler points ∪ marker points, disjoint', () => {
    const owned = [...RECONCILER_KILL_POINTS, ...BOOT_MARKER_KILL_POINTS];
    expect(new Set(owned).size, 'a kill point is owned by two suites').toBe(owned.length);
    expect(
      [...pointsFile()].sort(),
      'a file line has no owner, or an owner is not in the file',
    ).toEqual([...owned].sort());
  });

  it('every marker-suite point is a fixture below (coverage is exhaustive)', () => {
    expect(BOOT_MARKER_KILL_POINTS).toEqual(['boot.marker.arm', 'boot.marker.stamp']);
  });
});

describe('E2-T07 chaos — boot.marker.arm (armed session, no boot stamp)', () => {
  it('SW recycle after the kill: the durable arm reads warm (arm IS the protection)', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    unwrap(await runWake(area, VERSION_1, clock)); // established device, seq 1
    // Kill at arm: alive seq 2 durably written, boot stamp left at seq 1.
    unwrap(await area.port.sessionSet(MARKER_KEYS.alive, makeAlive({ bootSeq: 2 })));
    const signal = unwrap(await runWake(area, VERSION_1, clock));
    expect(signal.cause).toBe('warm-recycle'); // session never died ⇒ invisible
    expect(copyKeyFor(signal.cause, true)).toBeNull();
    expect((area.raw('local')[MARKER_KEYS.boot] as { bootSeq: number }).bootSeq).toBe(3);
  });

  it('browser restart after the kill: classification falls back to the previous cycle’s stamps — lawful crash', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    unwrap(await runWake(area, VERSION_1, clock)); // seq 1, install absent, boot v1
    // Kill at arm mid-second-wake, then the browser itself dies: session gone,
    // boot stamp from cycle 1 is the freshest COMPLETED truth.
    area.restartBrowser();
    await area.port.localSet(MARKER_KEYS.boot, makeBoot({ bootSeq: 1, atTs: clock.now() - 10 }));
    const signal = unwrap(await runWake(area, VERSION_1, clock));
    expect(signal.cause).toBe('crashed'); // no update evidence anywhere ⇒ crash
    expect(signal.evidence.lastBootVersion).toBe(VERSION_1); // stale-but-lawful input
    expect(copyKeyFor(signal.cause, true)).toBe('msg.recovery.crashed');
    // Self-heal: the next wake within this session is warm with full stamps.
    const healed = unwrap(await runWake(area, VERSION_1, clock));
    expect(healed.cause).toBe('warm-recycle');
  });

  it('virgin-device kill-at-arm collapses to first-run (never a fabricated crash)', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    // onInstalled fired (install stamp), the first wake armed alive then died
    // before stamping; the browser then restarted: session and boot stamp both
    // absent. Identical to a fresh first boot ⇒ W1 re-entry, per the table.
    unwrap(await stampInstall(area, 'install', VERSION_1, clock));
    area.restartBrowser();
    const signal = unwrap(await runWake(area, VERSION_1, clock));
    expect(signal.cause).toBe('first-run');
    expect(signal.evidence.installReason).toBe('install');
    expect(copyKeyFor(signal.cause, true)).toBeNull();
  });
});

describe('E2-T07 chaos — boot.marker.stamp (truncated onInstalled wake)', () => {
  it('extension update stamp durable, wake killed before arm/stamp ⇒ next boot reads updated', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    unwrap(await runWake(area, VERSION_1, clock)); // established v1 device
    area.restartBrowser(); // browser dies under v1
    // The relaunched browser applies the extension update: onInstalled stamps
    // v2 durably, then THAT wake dies before arming (the fenced kill point).
    clock.tick(100);
    unwrap(await stampInstall(area, 'update', VERSION_2, clock, VERSION_1));
    area.restartBrowser(); // the truncated update wake's own death/Chrome recycle
    const signal = unwrap(await runWake(area, VERSION_2, clock));
    expect(signal.cause).toBe('updated'); // stamp is fresh and version moved
    expect(signal.evidence.installedVersion).toBe(VERSION_2);
    expect(copyKeyFor(signal.cause, true)).toBe('msg.recovery.updated');
    // R16 no-double: a later same-build restart is a crash, never "updated" again.
    area.restartBrowser();
    const later = unwrap(await runWake(area, VERSION_2, clock));
    expect(later.cause).toBe('crashed');
  });

  it('chrome_update stamp (same version) durable, wake truncated ⇒ updated via timestamp rule', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    unwrap(await runWake(area, VERSION_1, clock));
    area.restartBrowser();
    clock.tick(100);
    unwrap(await stampInstall(area, 'chrome_update', VERSION_1, clock));
    area.restartBrowser();
    const signal = unwrap(await runWake(area, VERSION_1, clock));
    expect(signal.cause).toBe('updated'); // ts strictly newer than the last boot
  });

  it('failure storms at every storage boundary: never throws, always total, self-heals', async () => {
    const area = makeMarkerArea();
    const clock = makeClock();
    const causes: string[] = [];
    const gapCounts: number[] = [];
    // 0: read boundary down      ⇒ undetectable (+gap), no writes attempted.
    area.failNext('session.get', 'E_CAPABILITY_API');
    // 1: arm + stamp boundaries  ⇒ first-run classification stands, gaps disclose.
    area.failNext('session.set', 'E_QUOTA');
    area.failNext('local.set', 'E_CAPABILITY_API');
    // (Queued one-shots are consumed exactly by the ops above; later wakes heal.)
    const expected = ['undetectable', 'first-run', 'first-run', 'undetectable', 'warm-recycle'];
    for (let i = 0; i < expected.length; i += 1) {
      if (i === 3) area.failNext('session.get', 'E_CAPABILITY_API');
      const signal = unwrap(await runWake(area, VERSION_1, clock)); // never rejects
      causes.push(signal.cause);
      gapCounts.push(signal.gaps.length);
    }
    expect(causes).toEqual(expected);
    expect(gapCounts[0]).toBeGreaterThan(0);
    expect(gapCounts[1]).toBeGreaterThan(1); // both write boundaries disclosed
    expect(gapCounts[2]).toBe(0); // full recovery once boundaries behave
    expect(gapCounts[4]).toBe(0);
  });
});
