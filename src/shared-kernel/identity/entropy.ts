// E1-T04 · EES §2.1 — platform entropy + wall-clock bindings.
// This is the ONLY file in the codebase allowed to be non-deterministic by design
// (ESLint determinism carve-out): entropy enters the system through here and nowhere else.
import { ledgeError } from '../result/error.js';
import { err, ok, type Result } from '../result/result.js';

export type RandomBytes = (length: number) => Uint8Array;
export type Now = () => number;

/** Platform CSPRNG, wrapped so failure is typed E_CAPABILITY_ENTROPY (fatal, first-run blocking). */
export function platformRandomBytes(length: number): Result<Uint8Array> {
  try {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues === undefined) {
      return err(
        ledgeError('E_CAPABILITY_ENTROPY', { reason: 'crypto.getRandomValues unavailable' }),
      );
    }
    return ok(cryptoApi.getRandomValues(new Uint8Array(length)));
  } catch {
    return err(ledgeError('E_CAPABILITY_ENTROPY', { reason: 'crypto.getRandomValues threw' }));
  }
}

export function platformRandomBytesOrThrow(length: number): Uint8Array {
  const r = platformRandomBytes(length);
  if (!r.ok)
    throw new Error(`${r.error.code}: ${r.error.details?.['reason'] ?? 'entropy failure'}`);
  return r.value;
}

export const platformNow: Now = () => Date.now();
