// E1-T05 · EES §2.2 / ADR-004 — hybrid logical clock stamps {seq, lamport, deviceId, wallClock}.
// HLC field set frozen v1; additions only via new optional fields (tolerated by old readers).
// SKEW LAW: wallClock is informational only — NO correctness rule may depend on it.
// The kernel never reads platform time; callers supply wallClock at the adapter boundary.
import type { DeviceId } from '../identity/device-id.js';

export interface Hlc {
  /** Per-device monotonic event counter. */
  readonly seq: number;
  /** Lamport clock — never decreases within a device journal. */
  readonly lamport: number;
  /** Device that issued the stamp. */
  readonly deviceId: DeviceId;
  /** Informational wall time (ms). Never compared, never trusted. */
  readonly wallClock: number;
}

const COUNTER_MAX = Number.MAX_SAFE_INTEGER;

const assertCounter = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`HLC ${name} must be a non-negative safe integer; got ${value}`);
  }
};

export function isHlc(candidate: unknown): candidate is Hlc {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  return (
    Number.isSafeInteger(c['seq']) &&
    (c['seq'] as number) >= 0 &&
    Number.isSafeInteger(c['lamport']) &&
    (c['lamport'] as number) >= 0 &&
    typeof c['deviceId'] === 'string' &&
    Number.isSafeInteger(c['wallClock'])
  );
}

export function zeroHlc(deviceId: DeviceId): Hlc {
  return { seq: 0, lamport: 0, deviceId, wallClock: 0 };
}

/** Issue the next stamp for a local event. seq and lamport both advance by one. */
export function advance(local: Hlc, wallClock: number): Hlc {
  assertCounter('seq', local.seq);
  assertCounter('lamport', local.lamport);
  if (local.seq >= COUNTER_MAX || local.lamport >= COUNTER_MAX) {
    throw new TypeError(
      'HLC counter exhaustion is a caller bug (single-device year-2000-class event)',
    );
  }
  return {
    seq: local.seq + 1,
    lamport: local.lamport + 1,
    deviceId: local.deviceId,
    wallClock,
  };
}

/** Incorporate a remote observation, then stamp the new local event. Device stays local. */
export function merge(local: Hlc, remote: Hlc, wallClock: number): Hlc {
  assertCounter('seq', local.seq);
  assertCounter('lamport', local.lamport);
  assertCounter('remote.lamport', remote.lamport);
  if (local.seq >= COUNTER_MAX || local.lamport >= COUNTER_MAX || remote.lamport >= COUNTER_MAX) {
    throw new TypeError('HLC counter exhaustion is a caller bug');
  }
  return {
    seq: local.seq + 1,
    lamport: Math.max(local.lamport, remote.lamport) + 1,
    deviceId: local.deviceId,
    wallClock,
  };
}

/**
 * Deterministic total order across devices: (lamport, deviceId, seq).
 * wallClock is deliberately absent — skew law. Used for merge/order display, never for durability.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

/** Logical equality (wallClock excluded — skew law). */
export const equalHlc = (a: Hlc, b: Hlc): boolean => compareHlc(a, b) === 0;

/**
 * Regression probe (EES §2.2 failure mode): within one device's journal the next stamp must
 * exceed the previous on both counters. Journal walks use this to mark a segment suspect.
 */
export function isRegression(prev: Hlc, next: Hlc): boolean {
  if (prev.deviceId !== next.deviceId) {
    throw new TypeError('isRegression is defined per-device; got two devices');
  }
  return next.seq <= prev.seq || next.lamport <= prev.lamport;
}
