// E1-T08 · EES §3.2 — error → copy-key map (data table; copy lives in
// src/surfaces/components/copy/catalog.json, enforced by scripts/error-map-lint.mjs).
// retryable: is automatic retry meaningful without user action? (EES §3.2)
// messageKey: user-facing statement of what happened. recoveryKey: the recovery path,
// rendered in the same breath (spec: "every error message carries the recovery path
// in the same sentence"). Internal codes map to generic calm entries.
export const ERROR_MAP = {
  E_CAPABILITY: {
    retryable: false,
    messageKey: 'msg.error.capability',
    recoveryKey: 'msg.recover.update',
  },
  E_CAPABILITY_API: {
    retryable: false,
    messageKey: 'msg.error.capability',
    recoveryKey: 'msg.recover.update',
  },
  E_CAPABILITY_ENTROPY: {
    retryable: false,
    messageKey: 'msg.error.capability',
    recoveryKey: 'msg.recover.restart',
  },
  E_CATEGORY_REASON: {
    retryable: false,
    messageKey: 'msg.error.refused',
    recoveryKey: 'msg.recover.settings',
  },
  E_CONSENT_DENIED: {
    retryable: false,
    messageKey: 'msg.error.refused',
    recoveryKey: 'msg.recover.settings',
  },
  E_CORRUPT_STORE: {
    retryable: false,
    messageKey: 'msg.error.store',
    recoveryKey: 'msg.recover.recovering',
  },
  E_DOMAIN_LEGALITY: {
    retryable: false,
    messageKey: 'msg.error.refused',
    recoveryKey: 'msg.recover.states',
  },
  E_DOMAIN_UNDO_CONFLICT: {
    retryable: false,
    messageKey: 'msg.error.conflict',
    recoveryKey: 'msg.recover.choose',
  },
  E_DURABILITY_TIMEOUT: {
    retryable: true,
    messageKey: 'msg.error.durability',
    recoveryKey: 'msg.recover.retry',
  },
  E_FILE_GUARD: {
    retryable: false,
    messageKey: 'msg.error.file',
    recoveryKey: 'msg.recover.file-path',
  },
  E_FORMAT_UNKNOWN: {
    retryable: false,
    messageKey: 'msg.error.format',
    recoveryKey: 'msg.recover.file-other',
  },
  E_JOURNAL_INTEGRITY: {
    retryable: false,
    messageKey: 'msg.error.journal',
    recoveryKey: 'msg.recover.recovering',
  },
  E_KEY_MISMATCH: {
    retryable: false,
    messageKey: 'msg.error.keys',
    recoveryKey: 'msg.recover.keys',
  },
  E_MIGRATION: {
    retryable: false,
    messageKey: 'msg.error.migration',
    recoveryKey: 'msg.recover.export',
  },
  E_NOT_FOUND_TAB: {
    retryable: false,
    messageKey: 'msg.error.tab-gone',
    recoveryKey: 'msg.recover.recent',
  },
  E_OFFSCREEN_SPAWN: {
    retryable: true,
    messageKey: 'msg.error.workroom',
    recoveryKey: 'msg.recover.retry',
  },
  E_OUTPUT_MALFORMED: {
    retryable: false,
    messageKey: 'msg.error.output',
    recoveryKey: 'msg.recover.retry',
  },
  E_PARSE_REJECTS: {
    retryable: false,
    messageKey: 'msg.error.format',
    recoveryKey: 'msg.recover.file-other',
  },
  E_PROVIDER_DOWN: {
    retryable: true,
    messageKey: 'msg.error.provider',
    recoveryKey: 'msg.recover.local',
  },
  E_PROVIDER_TIMEOUT: {
    retryable: true,
    messageKey: 'msg.error.provider',
    recoveryKey: 'msg.recover.local',
  },
  E_QUOTA: { retryable: false, messageKey: 'msg.error.quota', recoveryKey: 'msg.recover.space' },
  E_RATE_LANESHED: {
    retryable: true,
    messageKey: 'msg.error.busy',
    recoveryKey: 'msg.recover.wait',
  },
  E_REDACTED_BLOCK: {
    retryable: false,
    messageKey: 'msg.error.refused',
    recoveryKey: 'msg.recover.settings',
  },
  E_RELAY_DOWN: {
    retryable: true,
    messageKey: 'msg.error.relay',
    recoveryKey: 'msg.recover.local',
  },
  E_RENDER_CHUNK: {
    retryable: true,
    messageKey: 'msg.error.render',
    recoveryKey: 'msg.recover.retry',
  },
  E_RENDER_FATAL: {
    retryable: false,
    messageKey: 'msg.error.render',
    recoveryKey: 'msg.recover.restart',
  },
  E_SCHEMA_UPCAST_GAP: {
    retryable: false,
    messageKey: 'msg.error.schema',
    recoveryKey: 'msg.recover.report',
  },
} as const;
