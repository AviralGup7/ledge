// E1-T05 · completion criteria: property suite advance/merge/monotonicity (EES §2.2).
import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import type { DeviceId } from '../identity/index.js';
import { advance, compareHlc, isRegression, merge, zeroHlc, type Hlc } from './index.js';

const DEV = '0TESTDEVICE000000000000000' as DeviceId;
const DEV2 = '0TESTDEVICE000000000000001' as DeviceId;
const COUNTER_CAP = 1_000_000_000;

const arbCounter = fc.nat({ max: COUNTER_CAP });
const arbWall = fc.nat({ max: Number.MAX_SAFE_INTEGER });
const arbDevice = fc.constantFrom(DEV, DEV2);
const arbHlc: fc.Arbitrary<Hlc> = fc.record({
  seq: arbCounter,
  lamport: arbCounter,
  deviceId: arbDevice,
  wallClock: arbWall,
});

describe('E1-T05 property suite (FC_NUM_RUNS; 1000 PR / 10000 nightly)', () => {
  it('P1 advance: chain of N advances keeps seq and lamport strictly +1 per step', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 64 }),
        fc.array(arbWall, { minLength: 64, maxLength: 64 }),
        (n, walls) => {
          let cur = zeroHlc(DEV);
          let prevSeq = 0;
          let prevLamport = 0;
          for (let i = 0; i < n; i++) {
            cur = advance(cur, walls[i] ?? 0);
            if (cur.seq !== prevSeq + 1 || cur.lamport !== prevLamport + 1) return false;
            prevSeq = cur.seq;
            prevLamport = cur.lamport;
          }
          return true;
        },
      ),
    );
  });

  it('P2 merge: lamport(result) strictly exceeds both inputs; seq advances by one', () => {
    fc.assert(
      fc.property(arbHlc, arbHlc, arbWall, (local, remote, wall) => {
        const r = merge({ ...local, deviceId: DEV }, remote, wall);
        return (
          r.lamport > Math.max(local.lamport, remote.lamport) &&
          r.seq === local.seq + 1 &&
          r.deviceId === DEV
        );
      }),
    );
  });

  it('P3 skew law: wallClock choice never changes logical fields', () => {
    fc.assert(
      fc.property(arbHlc, arbWall, arbWall, (local, w1, w2) => {
        const a = advance(local, w1);
        const b = advance(local, w2);
        return compareHlc(a, b) === 0;
      }),
    );
  });

  it('P4 merge bound: final lamport stays within [max+1, max+k] across remote orderings', () => {
    // Law corrected by fast-check counterexample (l=0,r1=0,r2=5 → 6 vs 7): merge order is NOT
    // commutative — each receive is itself an event that advances the clock. The true invariant:
    // k merges from max lamport M always land in [M+1, M+k].
    fc.assert(
      fc.property(arbCounter, arbCounter, arbCounter, arbWall, arbWall, (l, r1, r2, w1, w2) => {
        const local = { seq: 0, lamport: l, deviceId: DEV, wallClock: 0 };
        const remA = { seq: 0, lamport: r1, deviceId: DEV2, wallClock: 0 };
        const remB = { seq: 0, lamport: r2, deviceId: DEV2, wallClock: 0 };
        const first = merge(merge(local, remA, w1), remB, w2);
        const second = merge(merge(local, remB, w1), remA, w2);
        const max = Math.max(l, r1, r2);
        const inBound = (h: Hlc) => h.lamport >= max + 1 && h.lamport <= max + 2;
        return inBound(first) && inBound(second);
      }),
    );
  });

  it('P4b single merge is exact: lamport = max(local, remote) + 1', () => {
    fc.assert(
      fc.property(arbCounter, arbCounter, arbWall, (l, r, w) => {
        const out = merge(
          { seq: 0, lamport: l, deviceId: DEV, wallClock: 0 },
          { seq: 0, lamport: r, deviceId: DEV2, wallClock: 0 },
          w,
        );
        return out.lamport === Math.max(l, r) + 1;
      }),
    );
  });

  it('P5 regression predicate: detects exactly counter non-increase', () => {
    fc.assert(
      fc.property(arbHlc, arbCounter, arbCounter, (prev, ds, dl) => {
        const p = { ...prev, deviceId: DEV };
        const next: Hlc = { seq: ds, lamport: dl, deviceId: DEV, wallClock: 0 };
        const regressed = isRegression(p, next);
        return regressed === (next.seq <= p.seq || next.lamport <= p.lamport);
      }),
    );
  });
});
