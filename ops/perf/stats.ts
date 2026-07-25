// E7-T02 · Sample statistics — the one vocabulary every scenario reports in
// (mission requirement: mean, median, P95, P99, minimum, maximum, standard deviation).

const PERCENT = 100;
const MEDIAN_PCT = 50;
const DECIMAL_PLACES_FACTOR = 1000;

export interface SampleStats {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly stddev: number;
}

/** Nearest-rank-with-linear-interpolation percentile on an ascending-sorted array. */
const percentile = (sorted: readonly number[], p: number): number => {
  const last = sorted.length - 1;
  if (last <= 0) return sorted[0] ?? 0;
  const rank = (p / PERCENT) * last;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const low = sorted[lo] ?? 0;
  const high = sorted[hi] ?? low;
  return low + (high - low) * (rank - lo);
};

const round3 = (x: number): number => Math.round(x * DECIMAL_PLACES_FACTOR) / DECIMAL_PLACES_FACTOR;

/** Summarize raw samples (units preserved — the caller declares ms / MB / events-per-s). */
export const summarize = (samples: readonly number[]): SampleStats => {
  if (samples.length === 0) {
    return { n: 0, mean: 0, median: 0, p95: 0, p99: 0, min: 0, max: 0, stddev: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
  return {
    n,
    mean: round3(mean),
    median: round3(percentile(sorted, MEDIAN_PCT)),
    p95: round3(percentile(sorted, PCT_P95)),
    p99: round3(percentile(sorted, PCT_P99)),
    min: round3(sorted[0] ?? 0),
    max: round3(sorted[n - 1] ?? 0),
    stddev: round3(Math.sqrt(variance)),
  };
};

export const PCT_P95 = 95;
export const PCT_P99 = 99;
