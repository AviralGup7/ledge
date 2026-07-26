// E4 · Correlation-id minting for surface → SW envelopes. §3.1 cid is "correlation/
// client op id, ULID" — it is never persisted truth, so minting it locally cannot
// corrupt anything; the SW validator only requires the frozen ULID shape
// (shared-kernel's mint is unreachable from src/surfaces by import law — this is the
// wire-encoding half of that contract shape, no ordering/DTO/business logic here).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const TIME_MAX = 281474976710655; // 2^48 - 1 (ULID time-field capacity, frozen format)
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10; // 80 bits of entropy per mint (ULID v1 shape)
const BITS_PER_CHAR = 5;
const BASE32 = 32;
const BYTE_BITS = 8;
const BINARY_RADIX = 2;
const HIGHEST_DIGIT = RANDOM_CHARS - 1;

/** Entropy seam (roots wire Date.now + crypto.getRandomValues; tests wire fixtures). */
export interface CidEntropy {
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
}

/**
 * Monotonic-per-millisecond ULID-shape mint: same-ms calls increment the entropy
 * block (base-32 carry from the right) instead of re-rolling, keeping cids strictly
 * sortable per context. Wire correlation only — journal ids are minted SW-side.
 */
export const createCidMinter = (entropy: CidEntropy): (() => string) => {
  let lastTime = -1;
  let lastRandom: readonly number[] = [];

  const encodeTime = (time: number): string => {
    // Clamp into the ULID 48-bit time field (kernel throws on overflow; a wire cid
    // mint must never throw — clamping keeps the frozen shape at absurd inputs).
    const clamped = Math.min(Math.max(0, Math.floor(time)), TIME_MAX);
    let remaining = clamped;
    let out = '';
    for (let i = 0; i < TIME_CHARS; i += 1) {
      out = CROCKFORD.charAt(remaining % BASE32) + out;
      remaining = Math.floor(remaining / BASE32);
    }
    return out;
  };

  const randomDigits = (): readonly number[] => {
    const bytes = entropy.randomBytes(RANDOM_BYTES);
    let bits = '';
    for (const b of bytes) bits += b.toString(BINARY_RADIX).padStart(BYTE_BITS, '0');
    const digits: number[] = [];
    for (let i = 0; i < RANDOM_CHARS; i += 1) {
      digits.push(parseInt(bits.slice(i * BITS_PER_CHAR, (i + 1) * BITS_PER_CHAR), 2));
    }
    return digits;
  };

  const increment = (digits: readonly number[]): readonly number[] => {
    const next = [...digits];
    for (let i = HIGHEST_DIGIT; i >= 0; i -= 1) {
      const d = next[i];
      if (d === undefined) break;
      if (d < BASE32 - 1) {
        next[i] = d + 1;
        return next;
      }
      next[i] = 0;
    }
    return next; // saturated (astronomically unlikely) — shape stays valid
  };

  return (): string => {
    const time = entropy.now();
    const random = time === lastTime ? increment(lastRandom) : randomDigits();
    lastTime = time;
    lastRandom = random;
    let out = encodeTime(time);
    for (const digit of random) out += CROCKFORD.charAt(digit);
    return out;
  };
};
