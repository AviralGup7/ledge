// E6-T03 · Diagnostics redactor (EES §2.15, ADR-027) — addresses are hashed by
// default, PASSING raw only while the include-addresses flip is active. Pure +
// total on primitives by construction; the sabotage seam exists so the boot
// self-test (and unit proofs) can force the fail-drop law to show its teeth.
import { fnv1a64 } from '@/shared-kernel/canon/fnv1a.js';

/** URL-ish cover: scheme URLs anywhere in a string. Domains ride fields keyed
 *  'url'/'domain'/'host' (declared-address carriers) AND inline scheme URLs. */
const SCHEME_URL = /https?:\/\/[^\s"')\]]+/giu;
const DOMAINISH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/\S*)?$/iu;

/** Field keys whose VALUES are address carriers even when domain-bare. */
const ADDRESS_KEYS: readonly string[] = ['url', 'domain', 'host', 'origin', 'href', 'fetchurl'];

const addressKey = (key: string): boolean => ADDRESS_KEYS.includes(key.toLowerCase());

const hashToken = (raw: string): string => `adr#${fnv1a64(raw)}`;

/** One string through the posture: scheme URLs hashed inline; declared-address
 *  values hashed whole (domain-bare included). */
export const redactString = (raw: string, keyHint: string | null): string => {
  const inline = raw.replace(SCHEME_URL, (url) => hashToken(url));
  if ((keyHint !== null && addressKey(keyHint) && DOMAINISH.test(inline)) || DOMAINISH.test(raw)) {
    // Whole-value domain/URL carrier — hash the whole thing (avoids partial leaks
    // like "example.com/path" surviving as host+path fragments).
    return hashToken(raw);
  }
  return inline;
};

export type PrimitiveFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Redact a fields record per posture. includeAddresses=true ⇒ passthrough (the
 * flip's WHOLE POINT is operator-readable addresses, ADR-027 opt-in).
 * Throws only when handed a non-primitive value — shape drift out of the
 * declared contract; callers take the fail-drop law from there.
 */
export const redactFields = (
  fields: PrimitiveFields | undefined,
  includeAddresses: boolean,
): PrimitiveFields | undefined => {
  if (fields === undefined) return undefined;
  if (includeAddresses) return fields;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      value !== null
    )
      throw new Error(`diag-redactor: non-primitive field '${key}'`);
    out[key] = typeof value === 'string' ? redactString(value, key) : value;
  }
  return out;
};

/**
 * Boot/CI self-test (EES §5 logs row: "redactor self-test on boot"): the redactor
 * MUST hash a planted address and MUST refuse (throw) a sabotaged non-primitive —
 * the fail-drop law's proof surface. Returns 'ok' | 'degraded' (never throws).
 */
export const selfTestRedactor = (redact: typeof redactFields): 'ok' | 'degraded' => {
  const plantedUrl = 'https://selftest.invalid/sentence?x=1';
  const redacted = redact({ url: plantedUrl, note: plantedUrl }, false);
  if (redacted === undefined) return 'degraded';
  const serialized = JSON.stringify(redacted);
  if (serialized.includes('selftest.invalid')) return 'degraded'; // raw survived
  if (!serialized.includes('adr#')) return 'degraded'; // no hash token anywhere
  let refused = false;
  try {
    redact({ bad: { nested: true } as unknown as string }, false);
  } catch {
    refused = true;
  }
  return refused ? 'ok' : 'degraded';
};
