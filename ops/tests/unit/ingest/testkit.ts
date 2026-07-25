// E2-T05 hub-ingest test equipment (TEST-ONLY). ops placement is structural law:
// a kit in src/application importing infrastructure fakes would triangulate the
// application-never-touches-infrastructure depcruise rule. Virtual time harness:
// one clock drives hub.now() AND the 50ms/250ms scheduler — deterministic windows,
// deadlines, and stalls.
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { TabInfo, TabsEvent } from '@/application/ports/tabs.port.js';
import { createIngestHub, type IngestHubDeps } from '@/application/hub/ingest/index.js';
import type { IngestScheduler, IngestReport } from '@/application/hub/ingest/index.js';
import type { AppendAck, ReadRangeResult } from '@/application/ports/journal.port.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { DEV_A, testId } from '@/infrastructure/journal/core/testkit.js';
import { createMemoryStorageEngine } from '@/infrastructure/storage/memory/memory-engine.js';
import type { Id, IdGenerator } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';

const BASE_WALL_MS = 1_785_000_000_000;

interface VirtualTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export interface VirtualTime {
  readonly now: () => number;
  readonly after: (ms: number, fn: () => void) => () => void;
  /** Advance the wall; fires every due timer in order (chained timers included). */
  readonly advanceTime: (ms: number) => void;
}

export const makeVirtualTime = (): VirtualTime => {
  let t = BASE_WALL_MS;
  let seq = 0;
  let timers: VirtualTimer[] = [];
  const after = (ms: number, fn: () => void): (() => void) => {
    seq += 1;
    const entry: VirtualTimer = { id: seq, at: t + ms, fn, cancelled: false };
    timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const advanceTime = (ms: number): void => {
    t += ms;
    for (;;) {
      const due = timers
        .filter((x) => !x.cancelled && x.at <= t)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const first = due[0];
      if (first === undefined) return;
      first.cancelled = true;
      timers = timers.filter((x) => x.id !== first.id);
      first.fn();
    }
  };
  return { now: () => t, after, advanceTime };
};

export interface IngestWorld {
  readonly hub: ReturnType<typeof createIngestHub>;
  readonly journal: JournalPort;
  readonly storage: StorageEnginePort;
  readonly time: VirtualTime;
  readonly reports: IngestReport[];
  /** Sabotage toggles — stall readRange/append with a typed journal error. */
  readonly stall: { read: boolean; append: boolean; hang: boolean };
  /** Deterministic tab factory: distinct browserTabId per call. */
  readonly tab: (n: number, url?: string) => TabInfo;
  readonly createdEvent: (tab: TabInfo) => TabsEvent;
  readonly ids: IdGenerator;
}

let idCounter = 100_000;

const deterministicIds = (): IdGenerator => ({
  nextId: () => {
    idCounter += 1;
    return testId(idCounter) as Id;
  },
  timeOf: () => 0,
});

export const makeWorld = async (sharedStorage?: StorageEnginePort): Promise<IngestWorld> => {
  const storage = sharedStorage ?? createMemoryStorageEngine();
  const opened = await storage.open();
  if (!opened.ok) throw new Error(`storage open: ${opened.error.code}`);
  const journal = createJournal(storage);
  const time = makeVirtualTime();
  const stall = { read: false, append: false, hang: false };
  const stalled = <T>(): Result<T, LedgeError> =>
    err(ledgeError('E_JOURNAL_INTEGRITY', { raw: 'test-stall' }));
  /** A hanging append never settles — the §2.8 deadline must do the talking. */
  const hang = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const gatedJournal: JournalPort = {
    ...journal,
    readRange: (q) =>
      stall.read ? Promise.resolve(stalled<ReadRangeResult>()) : journal.readRange(q),
    append: (batch, opts) => {
      if (stall.hang) return hang<never>() as Promise<Result<AppendAck, LedgeError>>;
      return stall.append ? Promise.resolve(stalled<AppendAck>()) : journal.append(batch, opts);
    },
    appendHinged: (batch, opts) => {
      if (stall.hang) return hang<never>() as Promise<Result<AppendAck, LedgeError>>;
      return stall.append
        ? Promise.resolve(stalled<AppendAck>())
        : journal.appendHinged(batch, opts);
    },
  };
  const deps: IngestHubDeps = {
    journal: gatedJournal,
    storage,
    deviceId: DEV_A,
    now: time.now,
    ids: deterministicIds(),
    scheduler: { after: time.after } satisfies IngestScheduler,
  };
  const reports: IngestReport[] = [];
  const hub = createIngestHub(deps);
  hub.onReport = (r) => {
    reports.push(r);
  };
  const tab = (n: number, url?: string): TabInfo => ({
    browserTabId: n,
    windowId: 1,
    index: 0,
    groupId: null,
    url: url ?? `https://w${n}.example/page`,
    title: `tab ${n}`,
    active: false,
    pinned: false,
    status: 'complete',
    discarded: false,
  });
  return {
    hub,
    journal,
    storage,
    time,
    reports,
    stall,
    tab,
    createdEvent: (t) => ({ kind: 'created', tab: t }),
    ids: deps.ids,
  };
};
