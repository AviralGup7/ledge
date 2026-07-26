// E3-APP · Application-services harness (TEST-ONLY) — boots the REAL public services
// over fake-indexeddb truth (Dexie engine + journal + intent ledger + V1 projection
// engine, all production code) with fake chrome/snapshots/ingest seams. Deterministic
// clocks and ids. Seed law: seed() stamps envelopes directly into the journal BEFORE
// the StreamAppender hydrates; its lazy head-hydration picks the head up, so the first
// service commit stamps seq head+1 with no drift (drift-retry stays the production-law
// safety net, exercised by the appender suite, not needed here).
import type { ViewDeltaFrame } from '@/application/ports/projection-engine.port.js';
import type { ProgressEmitter } from '@/application/hub/dispatch/progress.js';
import type {
  SessionPartRow,
  SnapshotBuild,
  SnapshotBuildInput,
  SnapshotsPort,
} from '@/application/ports/snapshots.port.js';
import type {
  StorageEnginePort,
  StoreName,
  StoredRecord,
} from '@/application/ports/storage-engine.port.js';
import type {
  CreateTabSpec,
  MoveTabTarget,
  TabInfo,
  TabsPort,
  TabsQueryFilter,
} from '@/application/ports/tabs.port.js';
import type {
  CreateWindowSpec,
  WindowInfo,
  WindowsPort,
} from '@/application/ports/windows.port.js';
import type { IngestHub } from '@/application/hub/ingest/types.js';
import { createIntentLedger } from '@/infrastructure/intents/ledger.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import {
  createServices,
  type AppServices,
  type ServiceDeps,
  type UseCtx,
} from '@/application/usecases/index.js';

export { DEV_A, testId };

const WALL_BASE_MS = 1_785_400_000_000;
const SNAPSHOT_PART_CHUNK = 50;
const BROWSER_TAB_BASE = 5_000;
const BROWSER_WINDOW_BASE = 900;
const EVENT_ID_BASE = 7_700_000;
const CID_BASE = 6_600_000;
const LEDGE_TAB_FIXTURE_BASE = 2_300_000;
const WINDOW_BUCKET_SPAN = 100;
const MIRROR_TAB_BASE = 10_000;
const SEED_EVENT_ID_OFFSET = 4_000;
const CID_FIXTURE_OFFSET = 1_000;
const ID_RANDOM_FILL = 7;

// ──────────────────────────── fake chrome tabs ────────────────────────────

export interface FakeTabs extends TabsPort {
  readonly liveRows: () => readonly TabInfo[];
  readonly seedLive: (n: number, over?: Partial<TabInfo>) => TabInfo;
  readonly removedLog: () => readonly (readonly number[])[];
  readonly createdLog: () => readonly CreateTabSpec[];
  /** Test control: make the NEXT remove() fail with this error code. */
  readonly failRemoveOnce: (code: string) => void;
}

export const makeFakeTabs = (): FakeTabs => {
  const live = new Map<number, TabInfo>();
  const removed: number[][] = [];
  const created: CreateTabSpec[] = [];
  let removeFailure: string | null = null;
  const seedLive = (n: number, over: Partial<TabInfo> = {}): TabInfo => {
    const info: TabInfo = {
      browserTabId: n,
      windowId: BROWSER_WINDOW_BASE + Math.floor(n / WINDOW_BUCKET_SPAN),
      index: n % WINDOW_BUCKET_SPAN,
      groupId: null,
      url: `https://site-${n}.test/x`,
      title: `tab-${n}`,
      active: false,
      pinned: false,
      status: 'complete',
      discarded: false,
      ...over,
    };
    live.set(n, info);
    return info;
  };
  return {
    liveRows: () => [...live.values()],
    seedLive,
    removedLog: () => removed.map((ids) => [...ids]),
    createdLog: () => [...created],
    failRemoveOnce: (code) => {
      removeFailure = code;
    },
    query: (filter?: TabsQueryFilter) => {
      const all = [...live.values()];
      const out =
        filter?.windowId === undefined ? all : all.filter((t) => t.windowId === filter.windowId);
      return Promise.resolve(ok(out));
    },
    get: (browserTabId: number) => {
      const hit = live.get(browserTabId);
      if (hit === undefined)
        return Promise.resolve(err(ledgeError('E_NOT_FOUND_TAB', { what: 'tab' })));
      return Promise.resolve(ok(hit));
    },
    remove: (ids) => {
      if (removeFailure !== null) {
        const code = removeFailure;
        removeFailure = null;
        return Promise.resolve(err(ledgeError(code as never, { raw: 'fake-chrome-fail' })));
      }
      const done: number[] = [];
      for (const id of ids) if (live.delete(id)) done.push(id);
      removed.push([...ids]);
      return Promise.resolve(ok(done));
    },
    create: (spec: CreateTabSpec) => {
      created.push(spec);
      const next = 1 + Math.max(0, ...live.keys());
      live.set(next, {
        browserTabId: next,
        windowId: spec.windowId ?? BROWSER_WINDOW_BASE,
        index: spec.index ?? 0,
        groupId: null,
        url: spec.url ?? 'about:blank',
        title: '',
        active: spec.active ?? false,
        pinned: false,
        status: 'complete',
        discarded: false,
      });
      return Promise.resolve(ok(next));
    },
    move: (ids, _target: MoveTabTarget) => Promise.resolve(ok([...ids])),
    onEvents: () => ({ close: () => undefined }),
  };
};

// ─────────────────────────── fake chrome windows ──────────────────────────

export interface FakeWindows extends WindowsPort {
  readonly createdLog: () => readonly CreateWindowSpec[];
  readonly liveWindows: () => readonly WindowInfo[];
}

/** Linked to the tabs fake: a created window mirrors one live tab per initial tabSpec
 *  (resume reads coordinates back via tabs.query({windowId}) — §6.5 mapping law). */
export const makeFakeWindows = (tabs: FakeTabs): FakeWindows => {
  const live: WindowInfo[] = [];
  const created: CreateWindowSpec[] = [];
  let mirrored = 0;
  return {
    createdLog: () => [...created],
    liveWindows: () => [...live],
    list: () => Promise.resolve(ok([...live])),
    create: (spec: CreateWindowSpec) => {
      created.push(spec);
      const windowId = BROWSER_WINDOW_BASE + 100 + live.length;
      live.push({ windowId, focused: true, type: 'normal', state: 'normal' });
      for (const tabSpec of spec.tabSpecs ?? []) {
        mirrored += 1;
        tabs.seedLive(BROWSER_TAB_BASE + MIRROR_TAB_BASE + mirrored, {
          windowId,
          ...(tabSpec.url !== undefined ? { url: tabSpec.url } : {}),
        });
      }
      return Promise.resolve(ok(windowId));
    },
    remove: (windowId) => {
      const i = live.findIndex((w) => w.windowId === windowId);
      if (i >= 0) live.splice(i, 1);
      return Promise.resolve(ok(undefined));
    },
    focus: () => Promise.resolve(ok(undefined)),
    onEvents: () => ({ close: () => undefined }),
  };
};

// ─────────────────────────── fake snapshots port ──────────────────────────

export interface FakeSnapshots extends SnapshotsPort {
  readonly buildInputs: () => readonly SnapshotBuildInput[];
}

export const makeFakeSnapshots = (): FakeSnapshots => {
  const inputs: SnapshotBuildInput[] = [];
  const byId = new Map<string, SnapshotBuild>();
  return {
    buildInputs: () => [...inputs],
    build: (input: SnapshotBuildInput) => {
      inputs.push(input);
      const snapshotId = testId(EVENT_ID_BASE + inputs.length);
      const parts: SessionPartRow[] = [];
      for (let start = 0; start < input.tabRecordIds.length; start += SNAPSHOT_PART_CHUNK) {
        parts.push({
          snapshotId,
          partIndex: parts.length,
          missionId: input.missionId,
          tabRecordIds: input.tabRecordIds.slice(start, start + SNAPSHOT_PART_CHUNK),
          groupStyles: input.groupStyles,
          takenAt: input.takenAt,
          trigger: input.trigger,
        });
      }
      const build: SnapshotBuild = {
        snapshotId,
        payload: {
          snapshotId,
          missionId: input.missionId,
          partCount: parts.length,
          tabRecordRefs: [...input.tabRecordIds],
          groupStyles: input.groupStyles,
          takenAt: input.takenAt,
          trigger: input.trigger,
        },
        parts,
      };
      byId.set(snapshotId, build);
      return Promise.resolve(ok(build));
    },
    parts: (snapshotId: string) => Promise.resolve(ok(byId.get(snapshotId)?.parts ?? [])),
  };
};

// ─────────────────────────── fake ingest hub (C1 seam) ────────────────────

/** Stateful first-run flag (production hinges meta firstRunDone): the first crawl
 *  applies; every later call reports the resend-safe idempotent skip. */
export const makeFakeIngest = (): IngestHub => {
  let done = false;
  return {
    firstRunIngest: (liveTabs: readonly TabInfo[]) => {
      const first = !done;
      done = true;
      return Promise.resolve(
        ok({
          kind: 'first-run' as const,
          applied: first,
          idempotentSkip: !first,
          missionsCreated: 0,
          tabsCaptured: liveTabs.length,
        }),
      );
    },
  } as unknown as IngestHub;
};

// ─────────────────────────── harness assembly ─────────────────────────────

export interface ProgressSpyEvent {
  readonly stage: number;
  readonly current?: number | undefined;
  readonly total?: number | undefined;
}

export interface UseCtxSpy {
  readonly ctx: UseCtx;
  readonly progressLog: readonly ProgressSpyEvent[];
  readonly pendings: readonly string[];
}

export interface SeedPlan {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Pure plan factory: a LIVE tab row correlated to the fake browser identity map. */
export const liveTabPlan = (n: number, over: Readonly<Record<string, unknown>> = {}): SeedPlan => {
  const browserTabId = BROWSER_TAB_BASE + n;
  return {
    type: 'TabObserved',
    payload: {
      ledgeTabId: testId(LEDGE_TAB_FIXTURE_BASE + n),
      url: `https://site-${n}.test/x`,
      title: `tab-${n}`,
      domain: `site-${n}.test`,
      browserTabId,
      windowId: BROWSER_WINDOW_BASE + Math.floor(n / WINDOW_BUCKET_SPAN),
      urlCanon: `site-${n}.test/x`,
      canonRulesV: 1,
      ts: WALL_BASE_MS + n,
      ...over,
    },
  };
};

export const browserTabIdOf = (n: number): number => BROWSER_TAB_BASE + n;
export const browserWindowIdOf = (n: number): number =>
  BROWSER_WINDOW_BASE + Math.floor(n / WINDOW_BUCKET_SPAN);
export const ledgeTabIdOf = (n: number): string => testId(LEDGE_TAB_FIXTURE_BASE + n);

export interface ServicesHarness {
  readonly services: AppServices;
  readonly engine: StorageEnginePort;
  readonly fakeTabs: FakeTabs;
  readonly fakeWindows: FakeWindows;
  readonly fakeSnapshots: FakeSnapshots;
  readonly frames: readonly ViewDeltaFrame[];
  /** Physical device stream (every event durability wrote — seeds + commits). */
  readonly events: () => Promise<readonly EventEnvelope[]>;
  readonly seed: (plans: readonly SeedPlan[]) => Promise<void>;
  readonly ctxOf: (n: number) => UseCtxSpy;
  readonly row: (store: StoreName, key: string) => Promise<StoredRecord | undefined>;
  readonly rows: (store: StoreName) => Promise<readonly StoredRecord[]>;
}

export const makeServices = async (
  opts: {
    readonly withIngest?: boolean | undefined;
    /** Extra projection-frame subscriber (outbox bridging in the integration slice). */
    readonly onFrame?: ((frame: ViewDeltaFrame) => void) | undefined;
    readonly importer?: ServiceDeps['importer'];
    readonly exporter?: ServiceDeps['exporter'];
    /** Late-bind factory (E5-T03): engine-derived deps (the exporters adapter's
     *  model source reads the harness engine) cannot exist before makeServices
     *  opens the store — the factory receives it during composition. */
    readonly exporterFactory?: ((engine: StorageEnginePort) => ServiceDeps['exporter']) | undefined;
    readonly search?: ServiceDeps['search'];
  } = {},
): Promise<ServicesHarness> => {
  const engine = await openEngine();
  const journal = createJournal(engine);
  const ledger = createIntentLedger({ engine, journal });
  const frames: ViewDeltaFrame[] = [];
  const projections = createV1ProjectionEngine({
    engine,
    journal,
    onDelta: (f) => {
      frames.push(f);
      opts.onFrame?.(f);
    },
  });
  const fakeTabs = makeFakeTabs();
  const fakeWindows = makeFakeWindows(fakeTabs);
  const fakeSnapshots = makeFakeSnapshots();
  let tick = 0;
  const now = (): number => {
    tick += 1;
    return WALL_BASE_MS + tick;
  };
  const ids = createIdGenerator({
    now,
    randomBytes: (n: number) => new Uint8Array(n).fill(ID_RANDOM_FILL),
  });
  const services = createServices({
    engine,
    journal,
    projections,
    ledger,
    snapshots: fakeSnapshots,
    tabs: fakeTabs,
    windows: fakeWindows,
    ids,
    deviceId: DEV_A,
    now,
    ...(opts.withIngest === true ? { ingest: makeFakeIngest() } : {}),
    ...(opts.importer !== undefined ? { importer: opts.importer } : {}),
    ...(opts.exporter !== undefined
      ? { exporter: opts.exporter }
      : opts.exporterFactory !== undefined
        ? { exporter: opts.exporterFactory(engine) }
        : {}),
    ...(opts.search !== undefined ? { search: opts.search } : {}),
  });

  let seedSeq = 0;
  const seed = async (plans: readonly SeedPlan[]): Promise<void> => {
    if (plans.length === 0) return;
    const envelopes: EventEnvelope[] = plans.map((plan, i) => {
      const seq = seedSeq + 1 + i;
      return {
        eventId: testId(EVENT_ID_BASE + SEED_EVENT_ID_OFFSET + seq) as EventEnvelope['eventId'],
        hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: WALL_BASE_MS + seq },
        type: plan.type as EventEnvelope['type'],
        payload: plan.payload as EventEnvelope['payload'],
        producerContext: 'sw',
      };
    });
    seedSeq += plans.length;
    const r = await journal.append(envelopes, { idempotencyKey: testId(CID_BASE + seedSeq) });
    if (!r.ok)
      throw new Error(
        `seed append failed: ${r.error.code} ${JSON.stringify(r.error.details ?? {})}`,
      );
    const applied = await projections.apply(envelopes);
    if (!applied.ok) throw new Error(`seed apply failed: ${applied.error.code}`);
  };

  const ctxOf = (n: number): UseCtxSpy => {
    const cid = testId(CID_BASE + CID_FIXTURE_OFFSET + n);
    const progressLog: ProgressSpyEvent[] = [];
    const pendings: string[] = [];
    const progress: ProgressEmitter = (event) => {
      progressLog.push(event);
    };
    return {
      ctx: {
        cid,
        token: { cid, isCancelled: () => false, throwIfCancelled: () => undefined },
        progress,
        notifyPending: (intentId) => {
          pendings.push(intentId);
        },
      },
      progressLog,
      pendings,
    };
  };

  const row = async (store: StoreName, key: string): Promise<StoredRecord | undefined> => {
    const r = await engine.txn([store], 'readonly', (tx) => tx.table<StoredRecord>(store).get(key));
    if (!r.ok) throw new Error(`row read failed: ${r.error.code}`);
    return r.value;
  };
  const rows = async (store: StoreName): Promise<readonly StoredRecord[]> => {
    const r = await engine.txn([store], 'readonly', (tx) =>
      tx.table<StoredRecord>(store).toArray(),
    );
    if (!r.ok) throw new Error(`rows read failed: ${r.error.code}`);
    return r.value;
  };

  return {
    services,
    engine,
    fakeTabs,
    fakeWindows,
    fakeSnapshots,
    frames,
    events: async () => {
      const r = await journal.readRange({ deviceId: DEV_A, fromSeq: 1 });
      if (!r.ok) throw new Error(`readRange failed: ${r.error.code}`);
      return [...r.value.events]
        .sort((a, b) => a.seq - b.seq || a.batchIndex - b.batchIndex)
        .map((e) => e.envelope);
    },
    seed,
    ctxOf,
    row,
    rows,
  };
};

/** Result unwrap (test-side brevity; failure renders a useful CI line). */
export const mustOk = async <T>(r: Promise<Result<T, LedgeError>>): Promise<T> => {
  const resolved = await r;
  if (!resolved.ok) throw new Error(`expected ok, got ${resolved.error.code}`);
  return resolved.value;
};
