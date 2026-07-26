// E7-T01 · Seeded PRNG for the synthetic corpus (AC: "generators deterministic").
// mulberry32 — 32-bit, tiny, and exact across JS engines (Math.imul arithmetic is
// integer-exact, so every platform produces the same stream for the same seed).
// Dependency-free by design: the corpus must be reusable from perf harness, tests,
// and scripts without dragging any layer's imports along.
const MULBERRY_STEP = 0x6d2b79f5;
const SCRAMBLE_LOW = 15;
const SCRAMBLE_MID = 7;
const SCRAMBLE_HIGH = 14;
const ODD_MIX = 61;
const UINT32_RANGE = 4_294_967_296; // 2^32

/** A deterministic uniform-[0,1) stream for `seed` (same seed ⇒ same stream, forever). */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_STEP) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> SCRAMBLE_LOW), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> SCRAMBLE_MID), t | ODD_MIX))) >>> 0;
    return ((t ^ (t >>> SCRAMBLE_HIGH)) >>> 0) / UINT32_RANGE;
  };
};

/** Deterministic integer in [0, bound) from the stream. */
export const intBelow = (rng: () => number, bound: number): number => Math.floor(rng() * bound);
