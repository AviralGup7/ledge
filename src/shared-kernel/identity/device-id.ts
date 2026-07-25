// E1-T04 · EES §2.1 / ADR-004 — deviceId: random, user-invisible, created on first run,
// immutable once provisioned (sync v2 relies on it). FORMAT FROZEN FOREVER:
// 26-char Crockford string encoding 128 random bits, canonical high-bits zero.
// Persistence is a storage concern (E2 boot); the kernel owns format + generation only.
import { encodeBytes } from './crockford.js';
import { platformRandomBytesOrThrow, type RandomBytes } from './entropy.js';

declare const deviceIdBrand: unique symbol;
export type DeviceId = string & { readonly [deviceIdBrand]: 'DeviceId' };

export const DEVICE_ID_LENGTH = 26;
const DEVICE_RANDOM_BYTES = 16; // 128 bits
// Full Crockford alphabet in every position (unlike Id, deviceId has no 48-bit time floor).
const DEVICE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isDeviceId(candidate: unknown): candidate is DeviceId {
  return (
    typeof candidate === 'string' &&
    DEVICE_ID_PATTERN.test(candidate) &&
    candidate.length === DEVICE_ID_LENGTH
  );
}

export function createDeviceId(randomBytes: RandomBytes = platformRandomBytesOrThrow): DeviceId {
  return encodeBytes(randomBytes(DEVICE_RANDOM_BYTES), DEVICE_ID_LENGTH) as DeviceId;
}
