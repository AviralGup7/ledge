// E1-T04 · golden tables (EES §13: kernel = golden tables) + monotonicity.
// ULID reference vector mirrors the public spec: encodeTime(1469918176385,10) === '01ARYZ6S41'.
import { describe, expect, it } from 'vitest';
import { createDeviceId, createIdGenerator, isDeviceId, isId } from './index.js';

const fixedBytes = (fill: number) => (length: number) => new Uint8Array(length).fill(fill);
const ULID_SPEC_VECTOR_TIME = 1469918176385; // canonical vector from the ULID specification
const ULID_SPEC_VECTOR_TIME_PART = '01ARYZ6S41';

describe('E1-T04 Id golden table (frozen format)', () => {
  it('zero time + zero entropy', () => {
    const g = createIdGenerator({ now: () => 0, randomBytes: fixedBytes(0x00) });
    expect(g.nextId()).toBe('00000000000000000000000000');
  });

  it('ULID spec time vector + zero entropy', () => {
    const g = createIdGenerator({
      now: () => ULID_SPEC_VECTOR_TIME,
      randomBytes: fixedBytes(0x00),
    });
    const id = g.nextId();
    expect(id.startsWith(ULID_SPEC_VECTOR_TIME_PART)).toBe(true);
    expect(id).toBe(`${ULID_SPEC_VECTOR_TIME_PART}${'0'.repeat(16)}`);
  });

  it('spec time + all-ones entropy ends in 16 Z chars', () => {
    const g = createIdGenerator({
      now: () => ULID_SPEC_VECTOR_TIME,
      randomBytes: fixedBytes(0xff),
    });
    // Crokford 'Z' = 31; 80 one-bits → all 'Z' random part (monotone path avoided: call once)
    expect(g.nextId()).toBe(`${ULID_SPEC_VECTOR_TIME_PART}${'Z'.repeat(16)}`);
  });

  it('timeOf round-trips the timestamp', () => {
    const g = createIdGenerator({
      now: () => ULID_SPEC_VECTOR_TIME,
      randomBytes: fixedBytes(0x2a),
    });
    expect(g.timeOf(g.nextId())).toBe(ULID_SPEC_VECTOR_TIME);
  });
});

describe('E1-T04 Id law', () => {
  it('isId accepts generated ids and rejects malformed strings', () => {
    const g = createIdGenerator({ now: () => 7, randomBytes: fixedBytes(0x01) });
    expect(isId(g.nextId())).toBe(true);
    expect(isId('not-an-id')).toBe(false);
    expect(isId('0000000000000000000000000')).toBe(false); // 25 chars
    expect(isId(42)).toBe(false);
  });

  it('same-ms calls stay lexically monotonic (monotone mode)', () => {
    const g = createIdGenerator({ now: () => 1000, randomBytes: fixedBytes(0x00) });
    const first = g.nextId();
    const second = g.nextId();
    const third = g.nextId();
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });

  it('clock rewind never breaks monotonicity', () => {
    let t = 2000;
    const rewind = () => {
      t = t === 2000 ? 1999 : t; // second call sees the past
      return t;
    };
    const g = createIdGenerator({ now: rewind, randomBytes: fixedBytes(0x40) });
    const a = g.nextId();
    const b = g.nextId();
    expect(a < b).toBe(true);
  });

  it('entropy overflow inside a millisecond bumps the artificial clock', () => {
    let calls = 0;
    const g = createIdGenerator({
      now: () => 5,
      randomBytes: () => {
        calls++;
        return new Uint8Array(10).fill(0xff);
      },
    });
    const first = g.nextId(); // time 5, entropy 0xFF…
    const second = g.nextId(); // increment overflow → time bumped to 6
    expect(first < second).toBe(true);
    expect(g.timeOf(second)).toBe(6);
    // entropy drawn unconditionally at entry (1+1) plus the post-overflow redraw (1)
    expect(calls).toBe(3);
  });

  it('differs across generators with distinct entropy', () => {
    const a = createIdGenerator({ now: () => 1, randomBytes: fixedBytes(0x00) });
    const b = createIdGenerator({ now: () => 1, randomBytes: fixedBytes(0x01) });
    expect(a.nextId()).not.toBe(b.nextId());
  });

  it('out-of-range time is a caller bug (TypeError), never a silent wrap', () => {
    const g = createIdGenerator({ now: () => -1, randomBytes: fixedBytes(0x00) });
    expect(() => g.nextId()).toThrow(TypeError);
  });
});

describe('E1-T04 deviceId', () => {
  it('golden: 128 zero bits → canonical form', () => {
    expect(createDeviceId(fixedBytes(0x00))).toBe('00000000000000000000000000');
  });
  it('golden: 128 one bits → trailing 2 padding bits zero', () => {
    const id = createDeviceId(fixedBytes(0xff));
    expect(isDeviceId(id)).toBe(true);
    expect(id).toBe(`${'Z'.repeat(25)}W`); // 130-bit window: 128 ones + 2 zero pad bits
  });
  it('distinct entropy ⇒ distinct devices', () => {
    expect(createDeviceId(fixedBytes(0x00))).not.toBe(createDeviceId(fixedBytes(0x01)));
  });
});
