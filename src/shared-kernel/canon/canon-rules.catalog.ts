// E1-T06 · ADR-016 — canonicalization rule table v1 (living data; updates are data, not schema).
// Denylist strips ONLY — all other params kept verbatim, fragments preserved, trailing slash
// normalized on bare path only. version rides events as canonRulesV for provenance.
export const CANON_RULES_V1 = {
  version: 1,
  // Family prefixes (lowercase-compare against decoded key).
  denyParamPrefixes: ['utm_'],
  // Exact parameter names (lowercase-compare against decoded key). ADR-016 named set +
  // mainstream single-vendor click ids of the same class (no semantic judgement — data).
  denyParams: [
    'fbclid',
    'gclid',
    'igshid',
    'mc_cid',
    'mc_eid',
    '_hsenc',
    '_hsmi',
    'mkt_tok',
    'msclkid',
    'dclid',
    'gbraid',
    'wbraid',
    'spm',
    'scm',
    'si',
    'igsh',
    'ved',
  ],
} as const;

// Structural shape for any future rule table (data-versioned, EES §2.3).
export interface CanonRules {
  readonly version: number;
  readonly denyParamPrefixes: readonly string[];
  readonly denyParams: readonly string[];
}
