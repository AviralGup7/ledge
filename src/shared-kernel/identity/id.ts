// E1-T04 · EES §2.1 / ADR-004 — record Id: ULID-shaped, collision-safe, lexically sortable.
// FORMAT FROZEN FOREVER (irreversible register): 10 chars time (48-bit ms) + 16 chars
// entropy (80-bit), Crockford base32, monotone within a millisecond. Parsers must accept
// v1-format IDs on all future reads.
import { decodeBig, encodeBig, encodeBytes } from './crockford.js';
import { platformNow, platformRandomBytesOrThrow, type Now, type RandomBytes } from './entropy.js';

declare const idBrand: unique symbol;
export type Id = string & { readonly [idBrand]: 'Id' };

export const ID_LENGTH = 26;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10; // 80 bits
const TIME_MAX = 281474976710655; // 2^48 - 1 (named: ULID time-field capacity)

const ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface IdEntropy {
  readonly now: Now;
  readonly randomBytes: RandomBytes;
}

export interface IdGenerator {
  /** Strictly monotonic Id — lexically sortable by creation time, even on repeated same-ms calls. */
  readonly nextId: () => Id;
  /** Timestamp the Id was minted at, in ms (informational, never used for ordering law). */
  readonly timeOf: (id: Id) => number;
}

export function isId(candidate: unknown): candidate is Id {
  return (
    typeof candidate === 'string' && ID_PATTERN.test(candidate) && candidate.length === ID_LENGTH
  );
}

/** Pure injectable generator — tests bind deterministic entropy; production binds platform. */
export function createIdGenerator(entropy: IdEntropy): IdGenerator {
  let lastTime = -1;
  let lastRandom: Uint8Array | null = null;

  const nextId = (): Id => {
    let time = entropy.now();
    if (time < 0 || time > TIME_MAX || !Number.isInteger(time)) {
      throw new TypeError(`Id time out of ULID range: ${time}`);
    }
    let random = entropy.randomBytes(RANDOM_BYTES);
    if (time === lastTime && lastRandom !== null) {
      const bumped = increment(lastRandom);
      if (bumped === null) {
        // Entropy exhausted within one millisecond — move the clock artificially forward.
        time = lastTime + 1;
        random = entropy.randomBytes(RANDOM_BYTES);
      } else {
        random = bumped;
      }
    }
    lastTime = time;
    lastRandom = random;
    return (encodeBig(time, TIME_CHARS) + encodeBytes(random, RANDOM_CHARS)) as Id;
  };

  const timeOf = (id: Id): number => decodeBig(id.slice(0, TIME_CHARS));

  return { nextId, timeOf };
}

const BYTE_MAX = 0xff;

/** Big-endian increment; null on all-0xFF overflow. */
function increment(bytes: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== BYTE_MAX) {
      out[i] = (out[i] ?? 0) + 1;
      return out;
    }
    out[i] = 0;
  }
  return null;
}

/** Production binding (platform CSPRNG + wall clock). Entropy failure surfaces at call time. */
export const platformIds: IdGenerator = createIdGenerator({
  now: platformNow,
  randomBytes: platformRandomBytesOrThrow,
});

export const compareIds = (a: Id, b: Id): number => (a < b ? -1 : a > b ? 1 : 0);
