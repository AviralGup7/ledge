// E1-T11 · EES §3.1 contractHash — schema-registry hash at build time. Both ends of a
// channel compute it from their bundled registry; the handshake compares. A drift means
// the two sides built from different contracts (§3.5 compat law ⇒ ResyncRequired{schema}).
import { fnv1a64, stableStringify } from '@/shared-kernel/canon/index.js';
import { MESSAGE_REGISTRY } from './message.registry.js';

let cached: string | undefined;

export function computeContractHash(): string {
  if (cached === undefined) cached = fnv1a64(stableStringify(MESSAGE_REGISTRY));
  return cached;
}

/** Test seam: hash an arbitrary registry-shaped object (drift fixtures). */
export const contractHashOf = (registryLike: unknown): string =>
  fnv1a64(stableStringify(registryLike));
