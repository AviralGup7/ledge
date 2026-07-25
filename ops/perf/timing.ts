// E7-T02 · Timing + memory primitives. Wall-clock via performance.now (monotonic,
// sub-ms). Memory via process.memoryUsage().heapUsed — the TS-layer standing footprint
// proxy for the EES §7.2 law; GC is explicit (--expose-gc on the perf lane) so peak and
// steady are distinguishable instead of allocator-luck.

const BYTES_PER_MB = 1_048_576;

export const nowMs = (): number => performance.now();

/** No-op when the flag is absent — stats treat GC as best-effort, never a dependency. */
export const forceGc = (): void => {
  globalThis.gc?.();
};

export const heapMB = (): number => process.memoryUsage().heapUsed / BYTES_PER_MB;

/**
 * PERF_TRACE=1 wall instrumentation — the 60-second house law's tuning
 * instrument (a cut is never blind; every wall-time budget cites a trace).
 * This is the harness's ONE sanctioned console sink: lint config forbids
 * console everywhere else, by design.
 */
export const perfTrace = (label: string): void => {
  if (process.env['PERF_TRACE'] === '1') {
    // eslint-disable-next-line no-console
    console.error(`[perf] ${label}`);
  }
};

/** perfTrace with elapsed-ms suffix from a `Date.now()` start mark. */
export const perfTraceWall = (label: string, started: number): void => {
  perfTrace(`${label}: ${Date.now() - started}ms`);
};

/** Time one async operation; returns its result and elapsed ms. */
export const timed = async <T>(
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly ms: number }> => {
  const start = nowMs();
  const result = await fn();
  return { result, ms: nowMs() - start };
};

export interface MemorySample {
  /** Heap before the workload (post-GC). */
  readonly baselineMB: number;
  /** Highest heap observed during/right after the workload (pre-GC). */
  readonly peakMB: number;
  /** Heap after the workload + GC (the standing cost the SW would carry). */
  readonly steadyMB: number;
}

/**
 * Measure the memory signature of one workload run: GC → baseline → run → peak →
 * GC → steady. Peaks across sampled iterations feed the harness stats.
 */
export const measureMemory = async (
  fn: (markPeak: () => void) => Promise<void>,
): Promise<MemorySample> => {
  forceGc();
  const baselineMB = heapMB();
  let peakMB = baselineMB;
  const markPeak = (): void => {
    peakMB = Math.max(peakMB, heapMB());
  };
  await fn(markPeak);
  markPeak();
  forceGc();
  return { baselineMB, peakMB, steadyMB: heapMB() };
};
