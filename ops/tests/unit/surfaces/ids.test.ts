// E4 · Wire-cid mint suite — the local ULID-shaped correlation id (never truth;
// journal ids are minted SW-side). Laws: frozen regex shape, uniqueness within a
// burst, strict monotonicity within the same millisecond, time-prefix ordering.
import { describe, expect, it } from 'vitest';
import { createCidMinter, type CidEntropy } from '@/surfaces/components/session/ids.js';

const ULID_SHAPE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ULID_LENGTH = 26;

const entropyAt = (now: () => number): CidEntropy => {
  let seed = 0xa5;
  return {
    now,
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (seed + i * 0x13) & 0xff;
      }
      seed += 1;
      return bytes;
    },
  };
};

describe('E4 ids · ULID shape', () => {
  it('mints 26-char Crockford-base32 ids matching the frozen shape', () => {
    const mint = createCidMinter(entropyAt(() => 1_700_000_000_000));
    for (let i = 0; i < 200; i += 1) {
      const id = mint();
      expect(id).toHaveLength(ULID_LENGTH);
      expect(id).toMatch(ULID_SHAPE);
    }
  });

  it('encodes the timestamp into the first 10 chars (sortable by time)', () => {
    const early = createCidMinter(entropyAt(() => 1_000_000_000_000));
    const late = createCidMinter(entropyAt(() => 2_000_000_000_000));
    expect(early().slice(0, 10) < late().slice(0, 10)).toBe(true);
  });

  it('never exceeds the ULID time ceiling (first char within [0-7])', () => {
    const farFuture = createCidMinter(entropyAt(() => Number.MAX_SAFE_INTEGER));
    const id = farFuture();
    expect(id).toMatch(ULID_SHAPE);
  });
});

describe('E4 ids · uniqueness & monotonicity', () => {
  it('same-millisecond mints are unique and strictly increasing (carry-increment)', () => {
    const now = 1_700_000_000_000;
    const mint = createCidMinter(entropyAt(() => now));
    const ids = new Set<string>();
    let previous = '';
    for (let i = 0; i < 64; i += 1) {
      const id = mint();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      if (previous !== '') expect(id > previous).toBe(true);
      previous = id;
    }
  });

  it('a new millisecond re-rolls entropy (ids across ms need not be adjacent)', () => {
    let now = 1_700_000_000_000;
    const mint = createCidMinter(entropyAt(() => now));
    const first = mint();
    now += 1;
    const second = mint();
    expect(first).not.toBe(second);
    expect(second > first).toBe(true); // time prefix dominates
  });

  it('entropy-seam variation drives distinct ids across minters', () => {
    const a = createCidMinter(entropyAt(() => 1_700_000_000_000));
    let seed = 0x00;
    const b = createCidMinter({
      now: () => 1_700_000_000_000,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) bytes[i] = (seed + i) & 0xff;
        seed += 1;
        return bytes;
      },
    });
    expect(a()).not.toBe(b());
  });
});
