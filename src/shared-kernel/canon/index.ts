// Public surface of shared-kernel/canon (E1-T06 · EES §2.3 / ADR-016).
export { CANON_RULES_V1 } from './canon-rules.catalog.js';
export type { CanonRules } from './canon-rules.catalog.js';
export type { CanonResult } from './canon.js';
export { canonicalize } from './canon.js';
export { fnv1a64 } from './fnv1a.js';
export { stableStringify } from './stable-stringify.js';
export { crc32Hex, CRC32_HEX_LENGTH } from './crc32.js';
