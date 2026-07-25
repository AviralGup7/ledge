// E1-T05 · golden unit tests (property suite lives in hlc.property.test.ts).
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../identity/index.js';
import { advance, compareHlc, equalHlc, isHlc, isRegression, merge, zeroHlc } from './index.js';

const DEV = '0TESTDEVICE000000000000000' as DeviceId;
const DEV2 = '0TESTDEVICE000000000000001' as DeviceId;

describe('E1-T05 HLC goldens', () => {
  it('genesis stamp', () => {
    expect(zeroHlc(DEV)).toEqual({ seq: 0, lamport: 0, deviceId: DEV, wallClock: 0 });
  });

  it('advance bumps both counters by one, stamps wallClock informationally', () => {
    expect(advance(zeroHlc(DEV), 1721800000000)).toEqual({
      seq: 1,
      lamport: 1,
      deviceId: DEV,
      wallClock: 1721800000000,
    });
  });

  it('merge takes max(lamports)+1 and keeps the local device', () => {
    const local = { seq: 5, lamport: 3, deviceId: DEV, wallClock: 0 };
    const remote = { seq: 99, lamport: 10, deviceId: DEV2, wallClock: 0 };
    expect(merge(local, remote, 42)).toEqual({ seq: 6, lamport: 11, deviceId: DEV, wallClock: 42 });
  });

  it('skew law: wallClock never participates in ordering', () => {
    const a = advance(zeroHlc(DEV), 0);
    const b = { ...a, wallClock: Number.MAX_SAFE_INTEGER };
    expect(compareHlc(a, b)).toBe(0);
    expect(equalHlc(a, b)).toBe(true);
  });

  it('total order is lamport → deviceId → seq', () => {
    const a = advance(zeroHlc(DEV), 0);
    const b = advance(a, 0); // lamport 2
    expect(compareHlc(a, b)).toBe(-1);
    const c = advance(zeroHlc(DEV2), 0);
    // same lamport, deviceId decides
    expect(compareHlc(a, c)).toBe(DEV < DEV2 ? -1 : 1);
  });

  it('isHlc guard', () => {
    expect(isHlc(zeroHlc(DEV))).toBe(true);
    expect(isHlc({ seq: -1, lamport: 0, deviceId: DEV, wallClock: 0 })).toBe(false);
    expect(isHlc(null)).toBe(false);
    expect(isHlc('hlc')).toBe(false);
  });
});

describe('E1-T05 regression probe (per-device law)', () => {
  const base = advance(advance(zeroHlc(DEV), 0), 0); // seq2 lamport2
  it('detects seq regression', () => {
    expect(isRegression(base, { ...base, seq: 2, lamport: 3 })).toBe(true);
  });
  it('detects lamport regression', () => {
    expect(isRegression(base, { ...base, seq: 3, lamport: 2 })).toBe(true);
  });
  it('clean advance is not a regression', () => {
    expect(isRegression(base, advance(base, 0))).toBe(false);
  });
  it('cross-device regression is a caller bug', () => {
    expect(() => isRegression(base, advance(zeroHlc(DEV2), 0))).toThrow(TypeError);
  });
});
