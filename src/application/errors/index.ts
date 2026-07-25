// E3-APP · Mission deliverable "Error mapping" — infrastructure errors never cross the
// application boundary. EES §3.2 keeps ONE closed code catalog (ADR-033 append-only), and
// that catalog already carries the calm copy surfaces render (msg.error.* / msg.recover.*).
// The application law therefore has three mechanical parts, all enforced here:
//   1. CONTAIN — foreign exceptions (Dexie/DOMException/TypeError...) never leave the
//      boundary; they become E_CAPABILITY with an operation label, never a stack or
//      exception message (UI must never receive recovery/journal/storage internals).
//   2. TRANSLATE — typed LedgeErrors pass within the catalog, but their details are
//      SANITIZED: internal raw markers and deep-site labels are replaced by an
//      application operation name (e.g. "command:ParkTab"), and detail keys are capped
//      to the wire-ui safe set (counts and ids only).
//   3. DEGRADE — unknown shapes (string throws, numbers) land in the same calm bucket.
// Codes are never invented here: adding a code is an ADR-033 act, not a mapping act.
import { ledgeError, type LedgeError, type ErrorPrimitive } from '@/shared-kernel/result/index.js';

/** Application operation labels the boundary stamps onto errors (details.operation). */
export const operationLabel = (family: 'command' | 'query', name: string): string =>
  `${family}:${name}`;

/** §3.2 details stay flat primitives; the boundary also CAPS the key count so a
 *  deep-layer detail flood cannot leak mechanics upward. */
const DETAIL_KEY_CAP = 8;

/** Detail keys that describe infrastructure mechanics — stripped at the boundary. */
const INTERNAL_DETAIL_KEYS = ['raw', 'site', 'segmentId', 'store', 'table'] as const;

const isPrimitive = (v: unknown): v is ErrorPrimitive =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Drop internal mechanics keys and any non-primitive value that slipped in. */
export const sanitizeDetails = (
  details: Readonly<Record<string, unknown>> | undefined,
  operation: string,
): Readonly<Record<string, ErrorPrimitive>> => {
  const out: Record<string, ErrorPrimitive> = { operation };
  if (details === undefined) return out;
  for (const [k, v] of Object.entries(details)) {
    if (Object.keys(out).length >= DETAIL_KEY_CAP) break;
    if (INTERNAL_DETAIL_KEYS.some((prefix) => k === prefix || k.startsWith(`${prefix}.`))) continue;
    if (k === 'operation') continue;
    if (isPrimitive(v)) out[k] = v;
  }
  return out;
};

const bestEffortName = (e: unknown, fallback: string): string => {
  if (typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string')
    return e.name;
  return fallback;
};

const isLedgeError = (e: unknown): e is LedgeError => {
  if (typeof e !== 'object' || e === null) return false;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' && c.startsWith('E_');
};

/**
 * The single mapping home every application boundary runs through. Total function:
 * accepts LedgeError | foreign exception | unknown, always returns a catalog-lawful
 * LedgeError with sanitized, operation-stamped details.
 */
export const toApplicationError = (input: unknown, operation: string): LedgeError => {
  if (isLedgeError(input)) {
    return {
      ...input,
      details: sanitizeDetails(input.details, operation),
    };
  }
  return ledgeError('E_CAPABILITY', {
    operation,
    fault: bestEffortName(input, 'unknown'),
  });
};
