// E7-T02 · Workload corpora — deterministic (seeded), registry-valid event streams.
// Journal sizes / event counts / projection counts are the mission's configurable
// knobs: everything here is a pure function of (seed, size) so a run is reproducible
// byte-for-byte on any host.
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { GroupStyle } from '@/infrastructure/snapshots/types.js';
import { createDeviceId, type DeviceId as KernelDeviceId } from '@/shared-kernel/identity/index.js';
import { DEV_A, testId } from '@/infrastructure/journal/core/testkit.js';
import { createPrng, type Prng } from './prng.js';

export { DEV_A, testId };

// Corpus weights (named per §2 — the mix models a browsing day, not a coin flip).
const W_TAB_OBSERVED = 50;
const W_TAB_UPDATED = 15;
const W_TAB_ACTIVATED = 10;
const W_TAB_CLOSED = 10;
const W_MISSION_FORMED = 3;
const W_MISSION_RENAMED = 2;
const W_TAB_ASSIGNED = 7;
const W_TAB_MOVED = 3;
const WEIGHT_TOTAL =
  W_TAB_OBSERVED +
  W_TAB_UPDATED +
  W_TAB_ACTIVATED +
  W_TAB_CLOSED +
  W_MISSION_FORMED +
  W_MISSION_RENAMED +
  W_TAB_ASSIGNED +
  W_TAB_MOVED;

/**
 * Install identity for boot/wake scenarios. Kernel-law: isDeviceId enforces the
 * frozen Crockford pattern (no I/L/O/U) — the journal testkits' DEV_A ("DEVICE")
 * deliberately fails it, so identity rows must use a kernel-minted id. Seeded
 * entropy keeps the harness deterministic.
 */
const INSTALL_ENTROPY_BYTE = 0x5a;
const INSTALL_ENTROPY_LEN = 16;
export const PERF_INSTALL_ID: KernelDeviceId = createDeviceId(() =>
  new Uint8Array(INSTALL_ENTROPY_LEN).fill(INSTALL_ENTROPY_BYTE),
);

// Id-namespace salts (disjoint ranges; Crockford-valid via testId).
export const IDS = {
  MISSION_BASE: 20_000_000,
  TAB_BASE: 10_000_000,
  EVENT_BASE: 30_000_000,
  PURGE_EVENT_BASE: 40_000_000,
  TABRECORD_BASE: 50_000_000,
  INTENT_BASE: 70_000_000,
  CID_BASE: 80_000_000,
  SNAPSHOT_BASE: 90_000_000,
} as const;

const MISSION_POOL_MAX = 100;
const WALL_BASE_MS = 1_785_000_000_000;
const URL_COUNT = 10_000;
const TITLE_WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
] as const;

type EventType =
  | 'TabObserved'
  | 'TabUpdated'
  | 'TabActivatedObserved'
  | 'TabClosedExternal'
  | 'MissionFormed'
  | 'MissionRenamed'
  | 'TabAssigned'
  | 'TabMoved';

const pickType = (prng: Prng): EventType => {
  const roll = prng.int(1, WEIGHT_TOTAL);
  let acc = 0;
  const table: readonly (readonly [EventType, number])[] = [
    ['TabObserved', W_TAB_OBSERVED],
    ['TabUpdated', W_TAB_UPDATED],
    ['TabActivatedObserved', W_TAB_ACTIVATED],
    ['TabClosedExternal', W_TAB_CLOSED],
    ['MissionFormed', W_MISSION_FORMED],
    ['MissionRenamed', W_MISSION_RENAMED],
    ['TabAssigned', W_TAB_ASSIGNED],
    ['TabMoved', W_TAB_MOVED],
  ];
  for (const [type, w] of table) {
    acc += w;
    if (roll <= acc) return type;
  }
  return 'TabObserved';
};

const missionPoolSize = (count: number): number =>
  Math.max(1, Math.min(MISSION_POOL_MAX, Math.ceil(count / W_TAB_OBSERVED)));

const titleOf = (prng: Prng): string =>
  `${TITLE_WORDS[prng.int(0, TITLE_WORDS.length - 1)]} ${TITLE_WORDS[prng.int(0, TITLE_WORDS.length - 1)]}`;

const payloadFor = (
  type: EventType,
  seq: number,
  prng: Prng,
  poolSize: number,
): Readonly<Record<string, unknown>> => {
  const missionId = testId(IDS.MISSION_BASE + prng.int(0, poolSize - 1));
  const tabId = testId(IDS.TAB_BASE + seq);
  switch (type) {
    case 'TabObserved': {
      const url = `https://example-${prng.int(1, URL_COUNT)}.test/page/${seq}`;
      return {
        ledgeTabId: tabId,
        browserTabId: BROWSER_TAB_BASE + seq,
        windowId: WINDOW_ID,
        url,
        urlCanon: url.toLowerCase(),
        canonRulesV: 1,
        title: titleOf(prng),
        domain: `example-${prng.int(1, URL_COUNT)}.test`,
        ts: WALL_BASE_MS + seq,
      };
    }
    case 'TabUpdated':
      return { ledgeTabId: tabId, changes: { title: titleOf(prng) } };
    case 'TabActivatedObserved':
      return { ledgeTabId: tabId, ts: WALL_BASE_MS + seq };
    case 'TabClosedExternal': {
      const base: Record<string, unknown> = {
        ledgeTabId: tabId,
        closedAt: WALL_BASE_MS + seq,
      };
      if (prng.next() < LAST_MISSION_PROBABILITY) base['lastMissionId'] = missionId;
      return base;
    }
    case 'MissionFormed':
      return {
        missionId,
        name: `mission-${titleOf(prng)}`,
        namedBy: 'user',
        tabIds: [tabId],
        provenance: 'perf-corpus',
      };
    case 'MissionRenamed':
      return { missionId, name: `renamed-${titleOf(prng)}`, namedBy: 'user' };
    case 'TabAssigned':
      return { tabId, missionId };
    case 'TabMoved':
      return {
        tabId,
        missionId,
        fromMissionId: testId(IDS.MISSION_BASE + prng.int(0, poolSize - 1)),
      };
  }
};

/**
 * One deterministic journal corpus: `count` envelopes, seq 1..count on DEV_A,
 * lamport == seq (non-decreasing law), mixed registry-valid types. Identical
 * (seed, count) ⇒ identical bytes on every host.
 */
export const makeJournalCorpus = (
  count: number,
  seed: number,
  deviceId: DeviceId = DEV_A,
): readonly EventEnvelope[] => {
  const prng = createPrng(seed);
  const poolSize = missionPoolSize(count);
  const out: EventEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = i + 1;
    const type = pickType(prng);
    out.push({
      eventId: testId(IDS.EVENT_BASE + seq) as EventEnvelope['eventId'],
      hlc: { seq, lamport: seq, deviceId, wallClock: WALL_BASE_MS + seq },
      type,
      payload: payloadFor(type, seq, prng, poolSize) as EventEnvelope['payload'],
      producerContext: 'sw',
    });
  }
  return out;
};

/** MissionRenamed-shaped envelopes targeting one mission (purge-exclusion corpora). */
export const makePurgedTargetEvents = (
  count: number,
  missionId: string,
  seed: number,
  deviceId: DeviceId = DEV_A,
): readonly EventEnvelope[] => {
  const prng = createPrng(seed);
  const out: EventEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = i + 1;
    out.push({
      eventId: testId(IDS.PURGE_EVENT_BASE + seq) as EventEnvelope['eventId'],
      hlc: { seq, lamport: seq, deviceId, wallClock: WALL_BASE_MS + seq },
      type: 'MissionRenamed',
      payload: {
        missionId,
        name: `purged-${titleOf(prng)}`,
        namedBy: 'user',
      } as EventEnvelope['payload'],
      producerContext: 'sw',
    });
  }
  return out;
};

/** Deterministic tab-record ids for snapshot/park workloads. */
export const makeTabRecordIds = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, i) => testId(IDS.TABRECORD_BASE + i + 1));

/** Tabs each synthetic group claims (slice of the refs it spans). */
const GROUP_TAB_SPAN = 10;
/** Synthetic browser tab id base (registry 'number' fields accept any int). */
const BROWSER_TAB_BASE = 100;
/** Share of TabClosedExternal rows carrying lastMissionId (realistic ~half). */
const LAST_MISSION_PROBABILITY = 0.5;
/** Synthetic chrome groupId base for GroupStyle rows. */
const GROUP_ID_BASE = 1_000;
/** The one synthetic window all corpus tabs live in. */
const WINDOW_ID = 1;
/** Even/odd split for synthetic group colors. */
const TWO = 2;

/** GroupStyle rows in the §4 shape (builder-validated; ids from the tab-ref space). */
export const makeGroupStyles = (
  count: number,
  tabRefs: readonly string[] = [],
): readonly GroupStyle[] =>
  Array.from({ length: count }, (_, i) => ({
    groupId: GROUP_ID_BASE + i,
    name: `group-${i}`,
    color: i % TWO === 0 ? 'blue' : 'grey',
    collapsed: false,
    tabOrder: tabRefs.slice(i * GROUP_TAB_SPAN, i * GROUP_TAB_SPAN + GROUP_TAB_SPAN),
  }));
