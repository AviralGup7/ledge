// E2-T07 marker property suite — the classification table and lifecycle held
// against random marker images and random device histories. Meets:
//   P-A1 totality: every image (incl. garbage records) maps to exactly one
//        cause; the classifier never throws.
//   P-A2 determinism: same image ⇒ identical signal (deep).
//   P-A3 decision-table invariants (metamodel, derived from the ADR-007/R16
//        table text — not from the implementation).
//   P-A4 copy-gate law: card keys ⟺ lossRisk∧abnormal; heartbeat ⟺ clean∧abnormal.
//   P-B1 lifecycle/model agreement over randomized device histories (installs,
//        wakes, restarts, write-boundary sabotage, tied clocks).
//   P-B2 bootSeq monotonicity across surviving boot stamps.
//   P-B3 twin-device determinism: same script, fresh worlds ⇒ identical causes.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyBoot, copyKeyFor, MARKER_KEYS } from './index.js';
import type { AliveMarker, BootCause, BootMarker, InstallMarker } from './types.js';
import {
  makeClock,
  makeMarkerArea,
  runWake,
  stampInstall,
  VERSION_1,
  VERSION_2,
  type MarkerArea,
  type TickClock,
} from './testkit.js';
import type { InstallReason } from './types.js';
import type { Result, LedgeError } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`unexpected err ${r.error.code}`);
  return r.value;
};

const CAUSES: readonly BootCause[] = [
  'warm-recycle',
  'first-run',
  'updated',
  'crashed',
  'undetectable',
];
const UPDATE_FAMILY: readonly string[] = ['update', 'chrome_update', 'shared_module_update'];
const VERSIONS = [VERSION_1, VERSION_2, '3.0.0'] as const;

// ---------------------------------------------------------------------------
// P-A · random marker images (garbage included — records are optional fields).
// ---------------------------------------------------------------------------

const reasonArb: fc.Arbitrary<InstallReason> = fc.constantFrom(
  'install',
  'update',
  'chrome_update',
  'shared_module_update',
);

const versionArb = fc.constantFrom(...VERSIONS);
const tsArb = fc.integer({ min: 0, max: 1_000_000 });

const aliveArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant('garbage'),
  fc.record(
    {
      schemaV: fc.constant(1),
      bootSeq: fc.integer({ min: 0, max: 1e6 }),
      version: versionArb,
      atTs: tsArb,
    },
    { requiredKeys: ['schemaV', 'bootSeq', 'version', 'atTs'] },
  ),
);

const installArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(42),
  fc.record(
    {
      schemaV: fc.constant(1),
      reason: reasonArb,
      previousVersion: fc.oneof(fc.constant(null), versionArb),
      version: versionArb,
      atTs: tsArb,
    },
    { requiredKeys: ['schemaV', 'reason', 'version', 'atTs'] },
  ),
);

const bootArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant({ wrong: 'shape' }),
  fc.record(
    {
      schemaV: fc.constant(1),
      bootSeq: fc.integer({ min: 0, max: 1e6 }),
      version: versionArb,
      atTs: tsArb,
    },
    { requiredKeys: ['schemaV', 'bootSeq', 'version', 'atTs'] },
  ),
);

/** Tolerant reader twin (the P-A model's own parse — deliberately re-derived). */
const asAlive = (v: unknown): AliveMarker | null => {
  const r = v as AliveMarker | null;
  return r !== null &&
    typeof r === 'object' &&
    (r as { schemaV?: unknown }).schemaV === 1 &&
    typeof (r as { bootSeq?: unknown }).bootSeq === 'number' &&
    typeof (r as { version?: unknown }).version === 'string' &&
    typeof (r as { atTs?: unknown }).atTs === 'number'
    ? r
    : null;
};
const asInstall = (v: unknown): InstallMarker | null => {
  const r = v as InstallMarker | null;
  return r !== null &&
    typeof r === 'object' &&
    (r as { schemaV?: unknown }).schemaV === 1 &&
    typeof (r as { reason?: unknown }).reason === 'string' &&
    ['install', 'update', 'chrome_update', 'shared_module_update'].includes(
      (r as { reason: string }).reason,
    ) &&
    typeof (r as { version?: unknown }).version === 'string' &&
    typeof (r as { atTs?: unknown }).atTs === 'number'
    ? r
    : null;
};
const asBoot = (v: unknown): BootMarker | null => asAlive(v) as BootMarker | null;

/** The P-A metamodel: the R16 decision table, restated from the doc text. */
const modelCause = (image: {
  sessionReadable: boolean;
  alive: AliveMarker | null;
  aliveAbsentProven: boolean;
  install: InstallMarker | null;
  boot: BootMarker | null;
}): BootCause => {
  if (!image.sessionReadable) return 'undetectable';
  if (image.alive !== null) return 'warm-recycle';
  if (!image.aliveAbsentProven) return 'undetectable';
  if (image.install === null && image.boot === null) return 'first-run';
  if (image.boot === null) {
    return image.install !== null && image.install.reason !== 'install' ? 'updated' : 'first-run';
  }
  if (image.install !== null && UPDATE_FAMILY.includes(image.install.reason)) {
    if (image.install.version !== image.boot.version) return 'updated';
    if (image.install.atTs > image.boot.atTs) return 'updated';
  }
  return 'crashed';
};

describe('E2-T07 marker property — random images (P-A)', () => {
  it('classification is total, deterministic, and meets the decision table (P-A1..A4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        aliveArb,
        installArb,
        bootArb,
        fc.boolean(),
        async (sessionReadable, aliveRaw, installRaw, bootRaw, lossRisk) => {
          const alive = asAlive(aliveRaw);
          const install = asInstall(installRaw);
          const boot = asBoot(bootRaw);
          const input = {
            sessionReadable,
            alive,
            aliveAbsentProven: sessionReadable && alive === null,
            install,
            boot,
          };
          const signal = classifyBoot(input);
          // P-A1 totality.
          expect(CAUSES).toContain(signal.cause);
          // P-A2 determinism.
          const again = classifyBoot(input);
          expect(again).toEqual(signal);
          // P-A3a metamodel agreement on every parsable image.
          expect(signal.cause).toBe(modelCause(input));
          // P-A3b abnormal ⟺ updated|crashed.
          expect(signal.abnormal).toBe(signal.cause === 'updated' || signal.cause === 'crashed');
          // P-A3c surviving table invariants (spot laws of the doc text).
          if (sessionReadable && alive !== null) expect(signal.cause).toBe('warm-recycle');
          if (!sessionReadable) expect(signal.cause).toBe('undetectable');
          if (signal.cause === 'first-run') {
            expect(boot).toBeNull();
            if (install !== null) expect(install.reason).toBe('install');
          }
          if (signal.cause === 'crashed') {
            expect(alive).toBeNull();
            expect(boot).not.toBeNull();
            if (install !== null && UPDATE_FAMILY.includes(install.reason)) {
              expect(install.version).toBe(boot?.version);
              expect(install.atTs).toBeLessThanOrEqual(boot?.atTs ?? -1);
            }
          }
          // P-A4 copy-gate law.
          const key = copyKeyFor(signal.cause, lossRisk);
          if (signal.cause === 'updated') {
            expect(key).toBe(lossRisk ? 'msg.recovery.updated' : 'msg.heartbeat.recovered');
          } else if (signal.cause === 'crashed') {
            expect(key).toBe(lossRisk ? 'msg.recovery.crashed' : 'msg.heartbeat.recovered');
          } else {
            expect(key).toBeNull();
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// P-B · randomized device histories vs a first-principles model.
// The model tracks ONLY durable record facts (alive presence, install record,
// boot record) per the table text; write-boundary sabotage SKIPS the predicted
// write (the driver knows exactly which one-shot it armed).
// ---------------------------------------------------------------------------

type DeviceOp =
  | { readonly kind: 'install'; readonly reason: InstallReason; readonly version: string }
  | { readonly kind: 'wake' }
  | { readonly kind: 'restart' }
  | { readonly kind: 'sabotageArm' }
  | { readonly kind: 'sabotageBootStamp' }
  | { readonly kind: 'tick'; readonly step: number };

const opArb: fc.Arbitrary<DeviceOp> = fc.oneof(
  fc
    .tuple(reasonArb, versionArb)
    .map(([reason, version]) => ({ kind: 'install', reason, version }) as const),
  fc.constant({ kind: 'wake' }) as fc.Arbitrary<DeviceOp>,
  fc.constant({ kind: 'restart' }) as fc.Arbitrary<DeviceOp>,
  fc.constant({ kind: 'sabotageArm' }) as fc.Arbitrary<DeviceOp>,
  fc.constant({ kind: 'sabotageBootStamp' }) as fc.Arbitrary<DeviceOp>,
  fc.integer({ min: 0, max: 100 }).map((step) => ({ kind: 'tick', step }) as const),
);

interface DeviceModel {
  alive: AliveMarker | null;
  install: InstallMarker | null;
  boot: BootMarker | null;
  version: string;
}

const modelWakeCause = (m: DeviceModel): BootCause =>
  modelCause({
    sessionReadable: true,
    alive: m.alive,
    aliveAbsentProven: m.alive === null,
    install: m.install,
    boot: m.boot,
  });

const runScript = async (
  area: MarkerArea,
  clock: TickClock,
  script: readonly DeviceOp[],
  initialVersion: string,
): Promise<{ causes: BootCause[]; bootSeqs: number[] }> => {
  const model: DeviceModel = { alive: null, install: null, boot: null, version: initialVersion };
  const causes: BootCause[] = [];
  const bootSeqs: number[] = [];
  // Pending one-shot sabotage (queue semantics — NEVER a boolean: consecutive
  // sabotage ops queue consecutive one-shot failures).
  let pendingArmFailures = 0;
  let pendingBootFailures = 0;

  for (const op of script) {
    switch (op.kind) {
      case 'install': {
        unwrap(await stampInstall(area, op.reason, op.version, clock, model.version));
        model.install = {
          schemaV: 1,
          reason: op.reason,
          previousVersion: model.version,
          version: op.version,
          atTs: clock.now(),
        };
        model.version = op.version; // the stamping wake runs the NEW build
        break;
      }
      case 'restart': {
        area.restartBrowser();
        model.alive = null; // ADR-007 §4: session dies on browser restart
        break;
      }
      case 'tick':
        clock.tick(op.step);
        break;
      case 'sabotageArm':
        // Key-scoped: the ARM boundary fails, install stamps/reads unaffected.
        area.failNext('session.set', 'E_QUOTA', MARKER_KEYS.alive);
        pendingArmFailures += 1;
        break;
      case 'sabotageBootStamp':
        area.failNext('local.set', 'E_CAPABILITY_API', MARKER_KEYS.boot);
        pendingBootFailures += 1;
        break;
      case 'wake': {
        const expectedCause = modelWakeCause(model);
        const seqBefore = model.alive?.bootSeq ?? model.boot?.bootSeq ?? 0;
        const armFails = pendingArmFailures > 0;
        const bootFails = pendingBootFailures > 0;
        if (armFails) pendingArmFailures -= 1;
        if (bootFails) pendingBootFailures -= 1;
        const signal = unwrap(await runWake(area, model.version, clock)); // never rejects
        expect(signal.cause).toBe(expectedCause);
        causes.push(signal.cause);
        // Sabotage disclosure: a boundary that failed THIS wake is always disclosed.
        if (armFails) expect(signal.gaps.join(',')).toContain('alive-marker-arm:E_QUOTA');
        if (bootFails) {
          expect(signal.gaps.join(',')).toContain('boot-marker-stamp:E_CAPABILITY_API');
        }
        // Model post-writes (predicted, sabotage-aware). A failed arm leaves
        // the PREVIOUS alive record durable (the write never landed); a failed
        // boot stamp likewise. Nothing is cleared by a failed write.
        const nextSeq = seqBefore + 1;
        if (!armFails) {
          model.alive = {
            schemaV: 1,
            bootSeq: nextSeq,
            version: model.version,
            atTs: clock.now(),
          };
        }
        if (!bootFails) {
          model.boot = {
            schemaV: 1,
            bootSeq: nextSeq,
            version: model.version,
            atTs: clock.now(),
          };
          bootSeqs.push(nextSeq);
        }
        break;
      }
    }
  }
  return { causes, bootSeqs };
};

describe('E2-T07 marker property — device histories (P-B)', () => {
  it('lifecycle agrees with the model on every randomized history (P-B1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 14 }),
        fc.constantFrom(VERSION_1, VERSION_2),
        async (script, initialVersion) => {
          const area = makeMarkerArea();
          const clock = makeClock();
          await runScript(area, clock, script, initialVersion);
        },
      ),
    );
  });

  it('bootSeq never regresses across surviving boot stamps (P-B2)', async () => {
    // Law: non-decreasing. Torn arm-fail/stamp-ok interleaves may REPEAT a seq
    // (the warm path's one-read law cannot see the fresher stamp — an honest
    // property of the design, encoded in the BootMarker doc); regression never.
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (script) => {
        const area = makeMarkerArea();
        const clock = makeClock();
        const { bootSeqs } = await runScript(area, clock, script, VERSION_1);
        for (let i = 1; i < bootSeqs.length; i += 1) {
          expect(bootSeqs[i]).toBeGreaterThanOrEqual(bootSeqs[i - 1] ?? 0);
        }
      }),
    );
  });

  it('twin-device runs of one script produce identical cause sequences (P-B3)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (script) => {
        const a = makeMarkerArea();
        const b = makeMarkerArea();
        const first = await runScript(a, makeClock(), script, VERSION_1);
        const second = await runScript(b, makeClock(), script, VERSION_1);
        expect(second.causes).toEqual(first.causes);
      }),
    );
  });
});
