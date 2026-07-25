// E7-T02 · Deterministic PRNG (mulberry32) — every workload the harness drives is a
// pure function of a seed, so corpora are byte-reproducible across hosts and CI runs.
// This is what "deterministic harness" means: measurements jitter, workloads never do.

const MULBERRY_INCREMENT = 0x6d2b79f5;
const UINT32_SPAN = 0x1_00_00_00_00;
// Algorithm word-mixing constants (mulberry32 spec values, named per §2).
const SHIFT_A = 15;
const SHIFT_B = 7;
const MIX_FACTOR_B = 61;
const FINAL_SHIFT = 14;

export interface Prng {
  /** Uniform float in [0, 1). */
  readonly next: () => number;
  /** Uniform integer in [lo, hi] (both inclusive). */
  readonly int: (lo: number, hi: number) => number;
}

/** mulberry32: tiny, fast, stable across engines; good enough for workload mixes. */
export const createPrng = (seed: number): Prng => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> SHIFT_A), t | 1);
    t ^= t + Math.imul(t ^ (t >>> SHIFT_B), t | MIX_FACTOR_B);
    return ((t ^ (t >>> FINAL_SHIFT)) >>> 0) / UINT32_SPAN;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
};
