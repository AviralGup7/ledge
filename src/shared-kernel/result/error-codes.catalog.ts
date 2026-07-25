// E1-T08 · EES §3.2 — typed error codes (data table; pure per P-08/registry-purity).
// Single source of truth for every E_* code a Result may carry. Codes are named exactly
// as the locked documents name them; new codes are append-only (ADR-033).
export const ERROR_CODES = [
  'E_CAPABILITY',
  'E_CAPABILITY_API',
  'E_CAPABILITY_ENTROPY',
  'E_CATEGORY_REASON',
  'E_CONSENT_DENIED',
  'E_CORRUPT_STORE',
  'E_DOMAIN_LEGALITY',
  'E_DOMAIN_UNDO_CONFLICT',
  'E_DURABILITY_TIMEOUT',
  'E_FILE_GUARD',
  'E_FORMAT_UNKNOWN',
  'E_JOURNAL_INTEGRITY',
  'E_KEY_MISMATCH',
  'E_MIGRATION',
  'E_NOT_FOUND_TAB',
  'E_OFFSCREEN_SPAWN',
  'E_OUTPUT_MALFORMED',
  'E_PARSE_REJECTS',
  'E_PROVIDER_DOWN',
  'E_PROVIDER_TIMEOUT',
  'E_QUOTA',
  'E_RATE_LANESHED',
  'E_REDACTED_BLOCK',
  'E_RELAY_DOWN',
  'E_RENDER_CHUNK',
  'E_RENDER_FATAL',
  'E_SCHEMA_UPCAST_GAP',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
