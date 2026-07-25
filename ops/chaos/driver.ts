// E2-T09 · the chaos DRIVER (EES §8 tooling class: "custom driver + fixtures").
// One module sweeps all three chaos fronts the mission names:
//
//   1. KILL POINTS — every ops/chaos/points.txt line is driven through its
//      owning fixture/markers (reconciler torn states through the REAL
//      journal+ledger; boot-marker torn wakes through the REAL lifecycle);
//      the outcome row is what the G1 evidence pins.
//   2. CORRUPTED JOURNALS — seeded bit-rot / crc-flip / checkpointed-rot /
//      head-drift fixtures: the scanner must NAME the damage precisely, the
//      healthy prefix must stay byte-honest, and the boot consumer must
//      degrade conservatively with ZERO writes (never silent truncation of
//      user truth — ADR-004/journal.port law).
//   3. FAULT INJECTION — withFaults (ops/chaos/faults.ts) wraps the engine:
//      seeded IDB latency + planned one-shot failures, typed and annotated.
//
// Kill semantics: mirrors MV3. A kill = the SW vanishes between durable
// phases; the fixture writes the durable half and simply never writes the
// rest. The driver then boots the owner subsystem over exactly that state.
import { stableStringify } from '@/shared-kernel/canon/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { JournalSegmentRecord } from '@/infrastructure/journal/core/types.js';
import {
  META_JOURNAL_HEADS_KEY,
  SEGMENT_ENTRY_CAP,
  type DeviceStreamHead,
} from '@/infrastructure/journal/core/types.js';
import { DEV_A, makeEnv, makeJournal, uniqueKey } from '@/infrastructure/journal/core/testkit.js';
import { copyKeyFor, MARKER_KEYS } from '@/infrastructure/recovery/marker/index.js';
import {
  makeAlive,
  makeBoot,
  makeClock,
  makeMarkerArea,
  runWake,
  stampInstall,
  VERSION_1,
  VERSION_2,
} from '@/infrastructure/recovery/marker/testkit.js';
import {
  KILL_POINT_FIXTURES,
  makeWorld,
  reconcile,
  type KillPointFixture,
} from '@/infrastructure/recovery/reconciler/testkit.js';
import { POINT_BINDINGS, type MarkerPointBinding } from './manifest.js';
import { digestKillPointsFile } from './evidence.js';
import { readKillPointsNormative } from './points-file.js';
import type {
  ChaosEvidenceBodyV1,
  CorruptedSeedOutcome,
  KillPointOutcome,
  MarkerPointOutcome,
  ReconcilerPointOutcome,
} from './evidence.js';

const unwrap = <T>(r: Result<T, LedgeError>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
  return r.value;
};

// Fixture constants (named per the repo law — testkit discipline binds ops).
const FIRST_BOOT_SEQ = 1;
const KILLED_ARM_SEQ = 2;
const STALE_BOOT_BACKSTEP_MS = 10;
const UPDATE_WAKE_TICK_MS = 100;
const HEAD_DRIFT_SEQ = 2;
const ROTTED_EVENT_ID = '0ROTTED0000000000000000000';
const CRC_FIRST_CHAR_ALT = 'f';
const CRC_FIRST_CHAR_BASE = '0';
const CRC_BODY_START = 1;

// ---------------------------------------------------------------------------
// 1 · Kill points.
// ---------------------------------------------------------------------------

/** Drive one reconciler-owned point: torn state ⇒ boot reconcile ⇒ outcome. */
export const runReconcilerPoint = async (
  fixture: KillPointFixture,
  options: { readonly engine?: StorageEnginePort } = {},
): Promise<ReconcilerPointOutcome> => {
  const w = await makeWorld(options.engine !== undefined ? { engine: options.engine } : {});
  try {
    await fixture.setup(w);
    const eventsBefore = (await w.readAll()).length;
    const report = unwrap(await reconcile(w), `reconcile@${fixture.point}`);
    const eventsAfter = (await w.readAll()).length;
    const res = report.resolutions[0];
    return {
      owner: 'reconciler',
      point: fixture.point,
      disposition: res?.disposition ?? 'none',
      outcome: report.outcome,
      lossRisk: report.lossRisk,
      intentsExamined: report.intentsExamined,
      securedCounted: res?.securedCounted ?? 0,
      liveLeftOpen: res?.liveLeftOpen ?? 0,
      evidenceTabs: res === undefined ? [] : [...res.evidenceTabs].sort((a, b) => a - b),
      eventsWrittenByReconcile: eventsAfter - eventsBefore,
    };
  } finally {
    await w.engine.close();
  }
};

/** boot.marker.arm — armed session, no boot stamp; previous completed cycle governs. */
const runArmPoint = async (point: string): Promise<MarkerPointOutcome> => {
  const area = makeMarkerArea();
  const clock = makeClock();
  unwrap(await runWake(area, VERSION_1, clock), 'arm:baseline-wake');
  // Kill at arm: alive seq=2 durable in session, boot stamp never re-stamped.
  unwrap(
    await area.port.sessionSet(MARKER_KEYS.alive, makeAlive({ bootSeq: KILLED_ARM_SEQ })),
    'arm:set',
  );
  area.restartBrowser();
  // The freshest COMPLETED truth is cycle 1's boot stamp (stale but lawful).
  unwrap(
    await area.port.localSet(
      MARKER_KEYS.boot,
      makeBoot({ bootSeq: FIRST_BOOT_SEQ, atTs: clock.now() - STALE_BOOT_BACKSTEP_MS }),
    ),
    'arm:stale-stamp',
  );
  const signal = unwrap(await runWake(area, VERSION_1, clock), 'arm:classify');
  const healed = unwrap(await runWake(area, VERSION_1, clock), 'arm:heal');
  return {
    owner: 'marker',
    point,
    cause: signal.cause,
    copyKey: copyKeyFor(signal.cause, true),
    followUpCause: healed.cause,
  };
};

/** boot.marker.stamp — truncated onInstalled update wake: fresh v2 stamp governs. */
const runStampPoint = async (point: string): Promise<MarkerPointOutcome> => {
  const area = makeMarkerArea();
  const clock = makeClock();
  unwrap(await runWake(area, VERSION_1, clock), 'stamp:baseline-wake');
  area.restartBrowser();
  clock.tick(UPDATE_WAKE_TICK_MS);
  // The relaunch applies the update: install stamp durable, that wake dies.
  unwrap(await stampInstall(area, 'update', VERSION_2, clock, VERSION_1), 'stamp:install');
  area.restartBrowser();
  const signal = unwrap(await runWake(area, VERSION_2, clock), 'stamp:classify');
  // R16 no-double: a later same-build restart is a crash, never "updated" again.
  area.restartBrowser();
  const later = unwrap(await runWake(area, VERSION_2, clock), 'stamp:no-double');
  return {
    owner: 'marker',
    point,
    cause: signal.cause,
    copyKey: copyKeyFor(signal.cause, true),
    followUpCause: later.cause,
  };
};

export const runMarkerPoint = async (binding: MarkerPointBinding): Promise<MarkerPointOutcome> =>
  binding.point === 'boot.marker.arm' ? runArmPoint(binding.point) : runStampPoint(binding.point);

// ---------------------------------------------------------------------------
// 2 · Corrupted-journal seeds (EES §8 "seeded truncations/bit-flips").
// ---------------------------------------------------------------------------

export type CorruptionClass =
  'rot-sealed' | 'rot-open-tail' | 'crc-flip' | 'checkpointed-rot' | 'head-drift';

export interface CorruptedSeedSpec {
  readonly seed: string;
  readonly damageClass: CorruptionClass;
  /** Suspect reason scanFull MUST name (journal segment law). */
  readonly expectSuspect: string;
  /**
   * Detection pathway (LAW, re-derived at E2-T09): the budgeted boot tail-walk
   * (scanTail ≤50ms law) degrades on corrupt BYTES at the point the consumer
   * READS them — the evidence scan's readRange is the refusing layer, so byte
   * rot always surfaces as 'evidence-scan' (never silently served, never
   * written over). Anchor drift (head-drift) poisons no served byte: the boot
   * reconciles from the CRC-verified stream itself (nothing fabricated),
   * reports 'clean', and prosecution is scanFull's release-gate surface.
   */
  readonly expectGapAt: 'integrity-probe' | 'evidence-scan' | null;
  /** Boot outcome under the seed: conservative 'recovered' vs honest 'clean'. */
  readonly expectBootOutcome: 'recovered' | 'clean';
  /** A healthy sealed prefix exists below the damage (byte-honesty probe applies). */
  readonly hasHealthyPrefix: boolean;
  /**
   * Read-refusal law per class. Rot classes poison a segment IN the full
   * range ⇒ every overlapping read is refused. Head-drift leaves every served
   * byte CRC-honest (the violation lives in the chain anchor, the SCANNER
   * owns it) ⇒ reads still serve exactly the healthy contiguous stream.
   */
  readonly expectOverlapRefused: boolean;
}

export const CORRUPTED_SEEDS: readonly CorruptedSeedSpec[] = [
  {
    seed: 'seed-01',
    damageClass: 'rot-sealed',
    expectSuspect: 'crc-mismatch',
    expectGapAt: 'evidence-scan',
    expectBootOutcome: 'recovered',
    hasHealthyPrefix: false,
    expectOverlapRefused: true,
  },
  {
    seed: 'seed-02',
    damageClass: 'rot-open-tail',
    expectSuspect: 'crc-mismatch',
    expectGapAt: 'evidence-scan',
    expectBootOutcome: 'recovered',
    hasHealthyPrefix: true,
    expectOverlapRefused: true,
  },
  {
    seed: 'seed-03',
    damageClass: 'crc-flip',
    expectSuspect: 'crc-mismatch',
    expectGapAt: 'evidence-scan',
    expectBootOutcome: 'recovered',
    hasHealthyPrefix: false,
    expectOverlapRefused: true,
  },
  {
    seed: 'seed-04',
    damageClass: 'checkpointed-rot',
    expectSuspect: 'crc-mismatch',
    expectGapAt: 'evidence-scan',
    expectBootOutcome: 'recovered',
    hasHealthyPrefix: false,
    expectOverlapRefused: true,
  },
  {
    seed: 'seed-05',
    damageClass: 'head-drift',
    expectSuspect: 'head-drift',
    expectGapAt: null,
    expectBootOutcome: 'clean',
    hasHealthyPrefix: true,
    expectOverlapRefused: false,
  },
];

interface JournalWorldSnapshot {
  readonly segmentsCanon: string;
  readonly headsCanon: string;
}

type MetaRow = { key: string; value: unknown };

const readSegments = async (engine: StorageEnginePort): Promise<readonly JournalSegmentRecord[]> =>
  unwrap(
    await engine.txn(['events'], 'readonly', (tx) =>
      tx.table<JournalSegmentRecord>('events').toArray(),
    ),
    'segments-read',
  );

const readHeads = async (engine: StorageEnginePort): Promise<Record<string, DeviceStreamHead>> => {
  const row = unwrap(
    await engine.txn(['meta'], 'readonly', (tx) =>
      tx.table<MetaRow>('meta').get(META_JOURNAL_HEADS_KEY),
    ),
    'heads-read',
  );
  return (row?.value ?? {}) as Record<string, DeviceStreamHead>;
};

const snapJournal = async (engine: StorageEnginePort): Promise<JournalWorldSnapshot> => ({
  segmentsCanon: stableStringify(await readSegments(engine)),
  headsCanon: stableStringify(await readHeads(engine)),
});

/** Re-write one segment store-direct with bytes whose CRC no longer verifies —
 *  bit-rot class: the write path never touched these bytes (ADR-004 accident model). */
const rotSegment = async (
  engine: StorageEnginePort,
  pick: 'sealed' | 'open',
  mode: 'payload' | 'crc-field',
): Promise<void> => {
  const segs = await readSegments(engine);
  const target = segs.find((s) => (pick === 'sealed' ? s.sealed : !s.sealed));
  if (target === undefined) throw new Error(`rot: no ${pick} segment seeded`);
  const mutated: JournalSegmentRecord =
    mode === 'crc-field'
      ? {
          ...target,
          crc: target.crc.startsWith(CRC_FIRST_CHAR_BASE)
            ? `${CRC_FIRST_CHAR_ALT}${target.crc.slice(CRC_BODY_START)}`
            : `${CRC_FIRST_CHAR_BASE}${target.crc.slice(CRC_BODY_START)}`,
        }
      : {
          ...target,
          entries: target.entries.map((entry, i) =>
            i === 0 ? { ...entry, eventId: ROTTED_EVENT_ID as never } : entry,
          ),
        };
  unwrap(
    await engine.txn(['events'], 'readwrite', (tx) => tx.table('events').put(mutated)),
    'rot-put',
  );
};

/** Truncation class: the device head advances past the bytes that exist — the
 *  tail simply isn't there anymore (torn segment write / lost tail rows). */
const driftHead = async (engine: StorageEnginePort): Promise<void> => {
  const head = await engine.txn(['meta'], 'readonly', (tx) =>
    tx.table<MetaRow>('meta').get(META_JOURNAL_HEADS_KEY),
  );
  const row = unwrap(head, 'head-get');
  if (row === null || row === undefined) throw new Error('head-drift: heads row absent');
  const value = row.value as Record<string, DeviceStreamHead>;
  const dev = value[DEV_A as string];
  if (dev === undefined) throw new Error('head-drift: device head absent');
  const drifted: Record<string, DeviceStreamHead> = {
    ...value,
    [DEV_A as string]: { ...dev, lastSeq: dev.lastSeq + HEAD_DRIFT_SEQ },
  };
  unwrap(
    await engine.txn(['meta'], 'readwrite', (tx) =>
      tx.table<MetaRow>('meta').put({ key: META_JOURNAL_HEADS_KEY, value: drifted }),
    ),
    'head-drift-put',
  );
};

/** Seed the two-segment base (sealed at cap + open tail), damage it per spec,
 *  then run detection + the conservative consumer. */
export const runCorruptedSeed = async (spec: CorruptedSeedSpec): Promise<CorruptedSeedOutcome> => {
  const { engine, journal } = await makeJournal();
  try {
    // Base world: SEG_CAP entries (sealed) + 1 entry (open tail).
    const batch = Array.from({ length: SEGMENT_ENTRY_CAP + 1 }, (_, i) => makeEnv(i + 1, i + 1));
    unwrap(
      await journal.append(batch.slice(0, SEGMENT_ENTRY_CAP), {
        idempotencyKey: uniqueKey(spec.seed),
      }),
      'seed-append-1',
    );
    unwrap(
      await journal.append(batch.slice(SEGMENT_ENTRY_CAP), {
        idempotencyKey: uniqueKey(spec.seed),
      }),
      'seed-append-2',
    );

    // Byte-honesty baseline: the sealed prefix as served BEFORE damage.
    const prefixBefore = spec.hasHealthyPrefix
      ? unwrap(
          await journal.readRange({ deviceId: DEV_A, fromSeq: 0, toSeq: SEGMENT_ENTRY_CAP }),
          'prefix-before',
        )
      : null;

    if (spec.damageClass === 'checkpointed-rot') {
      unwrap(await journal.checkpoint(), 'seed-checkpoint');
    }
    if (spec.damageClass === 'rot-sealed' || spec.damageClass === 'checkpointed-rot') {
      await rotSegment(engine, 'sealed', 'payload');
    } else if (spec.damageClass === 'rot-open-tail') {
      await rotSegment(engine, 'open', 'payload');
    } else if (spec.damageClass === 'crc-flip') {
      await rotSegment(engine, 'sealed', 'crc-field');
    } else {
      await driftHead(engine);
    }

    // Detection: scanFull names the damage, always.
    const scan = unwrap(await journal.scanFull(), 'scan-full');
    const suspects = [...new Set(scan.suspects.map((s) => s.reason))].sort();

    // Prefix honesty AFTER damage: healthy prefix still served byte-identical.
    let prefixHonest: boolean | 'none' = 'none';
    if (prefixBefore !== null) {
      const after = await journal.readRange({
        deviceId: DEV_A,
        fromSeq: 0,
        toSeq: SEGMENT_ENTRY_CAP,
      });
      prefixHonest =
        after.ok && stableStringify(after.value.events) === stableStringify(prefixBefore.events);
    }
    // Overlap law: any range that touches the damaged bytes is refused — the
    // corrupt segment is never served (journal.port law; recovery owns repair).
    const fullRange = await journal.readRange({ deviceId: DEV_A, fromSeq: 0 });
    const overlapRefused = !fullRange.ok;

    // Conservative consumer: boot reconcile over corrupt bytes never writes.
    const before = await snapJournal(engine);
    const w = await makeWorld({ engine });
    const report = unwrap(await reconcile(w), `reconcile@${spec.seed}`);
    const after = await snapJournal(engine);
    const journalFrozen =
      after.segmentsCanon === before.segmentsCanon && after.headsCanon === before.headsCanon;
    const gap = report.gaps.find(
      (g) => g.startsWith('integrity-probe:') || g.startsWith('evidence-scan:'),
    );

    return {
      seed: spec.seed,
      damageClass: spec.damageClass,
      detected: scan.status === 'suspect',
      suspects,
      bootOutcome: report.outcome,
      degraded: gap === undefined ? null : (gap.split(':')[0] ?? null),
      resolutionsIssued: report.resolutions.length,
      prefixHonest,
      overlapRefused,
      journalFrozen,
    };
  } finally {
    await engine.close();
  }
};

// ---------------------------------------------------------------------------
// 3 · The full sweep ⇒ G1 evidence body.
// ---------------------------------------------------------------------------

/** Drive every manifest-bound point + every corrupted seed (fresh worlds). */
export const runFullSweep = async (): Promise<ChaosEvidenceBodyV1> => {
  const killPoints: KillPointOutcome[] = [];
  for (const binding of POINT_BINDINGS) {
    killPoints.push(
      binding.owner === 'reconciler'
        ? await runReconcilerPoint(binding.fixture)
        : await runMarkerPoint(binding),
    );
  }
  const corruptedSeeds: CorruptedSeedOutcome[] = [];
  for (const spec of CORRUPTED_SEEDS) {
    corruptedSeeds.push(await runCorruptedSeed(spec));
  }
  return {
    schemaV: 1,
    gate: 'G1',
    suite: 'E2-T09',
    pointsCount: killPoints.length,
    pointsFileDigest: digestKillPointsFile(readKillPointsNormative()),
    killPoints,
    corruptedSeeds,
  };
};

/** Convenience re-export so suites bind fixtures without a second import path. */
export { KILL_POINT_FIXTURES };
