// E4 · Copy accessor — the ONLY path from a catalog key to rendered user-facing
// prose (§2 copy law; ledge/no-raw-copy enforces consumption, copy-lint guards the
// catalog's contents). Surfaces render keys, never literals. A missing key renders
// the key itself: a visible defect signal in dev, never a throw in production —
// rendering must be total (EES §8 fuzz posture applied to presentation).
import catalog from './catalog.json';

const TABLE: Readonly<Record<string, unknown>> = catalog;

const lookup = (key: string): string | undefined => {
  let node: unknown = TABLE;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Readonly<Record<string, unknown>>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
};

const INTERPOLATION = /\{([a-zA-Z]+)\}/g;

/**
 * Resolve `key` (msg.area.name) to calm copy with `{var}` interpolation.
 * Unknown variables interpolate to empty text (calm, never placeholders like `???`).
 */
export const copyOf = (key: string, vars?: Readonly<Record<string, string | number>>): string => {
  const found = lookup(key);
  if (found === undefined) return key;
  if (vars === undefined) return found;
  return found.replace(INTERPOLATION, (_raw, name: string) => {
    const value = vars[name];
    if (value === undefined) return '';
    return String(value);
  });
};

/** Presence probe — used by the coverage test that keeps keys and code in agreement. */
export const hasCopy = (key: string): boolean => lookup(key) !== undefined;
