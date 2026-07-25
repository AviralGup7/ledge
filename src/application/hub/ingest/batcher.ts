// E2-T05 · Blueprint batching law: pending items flush when 20 accumulate OR 50ms
// elapse from the first pending item, whichever fires first (line 334/618).
// The batcher is a generic queue+timer machine; mapping, envelope stamping and
// durability live in the hub's onBatch delegate. onBatch answers "keep draining?"
// — false pauses the drain with the untaken queue INTACT (the delegate re-homes
// the just-taken batch itself; arrival order is a law, not a convenience).
// Unbounded-queue law: enqueue never blocks (a slow journal shows up as queue
// depth, never dropped truth).
import type { IngestScheduler } from './types.js';
import { INGEST_BATCH_CAP, INGEST_BATCH_WINDOW_MS } from './types.js';

export interface BatcherDeps<TItem> {
  /** Called with each drained batch, in arrival order. Return false to pause the
   *  drain (journal stalled): the not-yet-taken tail stays queued and draining
   *  resumes on the next enqueue/flush. The delegate owns the taken batch's fate. */
  readonly onBatch: (batch: readonly TItem[]) => Promise<boolean>;
  readonly scheduler: IngestScheduler;
  readonly batchCap?: number | undefined;
  readonly windowMs?: number | undefined;
}

export interface Batcher<TItem> {
  enqueue(item: TItem): void;
  enqueueMany(items: readonly TItem[]): void;
  /** Force-drain everything pending (in order, ≤cap per batch, delegate-pausable). */
  flush(): Promise<void>;
  depth(): number;
  cancelWindowTimer(): void;
}

export function createBatcher<TItem>(deps: BatcherDeps<TItem>): Batcher<TItem> {
  const cap = deps.batchCap ?? INGEST_BATCH_CAP;
  const windowMs = deps.windowMs ?? INGEST_BATCH_WINDOW_MS;
  let queue: TItem[] = [];
  let windowTimer: (() => void) | null = null;
  /** One drain in flight at a time (single-writer discipline for event order). */
  let draining: Promise<void> = Promise.resolve();

  const cancelWindowTimer = (): void => {
    if (windowTimer !== null) {
      windowTimer();
      windowTimer = null;
    }
  };

  const startWindowIfIdle = (): void => {
    if (windowTimer === null && queue.length > 0) {
      windowTimer = deps.scheduler.after(windowMs, () => {
        windowTimer = null;
        scheduleDrain();
      });
    }
  };

  const takeBatch = (): readonly TItem[] | null => {
    if (queue.length === 0) return null;
    const batch = queue.slice(0, cap);
    queue = queue.slice(cap);
    return batch;
  };

  const scheduleDrain = (): void => {
    draining = draining.then(async () => {
      for (;;) {
        const batch = takeBatch();
        if (batch === null) {
          cancelWindowTimer();
          return;
        }
        const keepDraining = await deps.onBatch(batch);
        if (!keepDraining) {
          cancelWindowTimer();
          return;
        }
      }
    });
  };

  return {
    enqueue: (item) => {
      queue.push(item);
      if (queue.length === 1) startWindowIfIdle();
      if (queue.length >= cap) {
        cancelWindowTimer();
        scheduleDrain();
      }
    },
    enqueueMany: (items) => {
      for (const item of items) queue.push(item);
      if (queue.length > 0) startWindowIfIdle();
      if (queue.length >= cap) {
        cancelWindowTimer();
        scheduleDrain();
      }
    },
    flush: () => {
      cancelWindowTimer();
      scheduleDrain();
      return draining;
    },
    depth: () => queue.length,
    cancelWindowTimer,
  };
}
