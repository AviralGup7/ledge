// E1-T09 · EES §5 storage contracts — store registry (data-only per P-08 / registry-purity).
// The 15 stores of schema v1, named exactly as EES §5 names them. Roadmap E2-T04
// ("All 15 stores + migration runner") confirms this list is complete and frozen at v1;
// future stores are additive schema versions, never renames (ADR-034).
export const STORE_NAMES = [
  'events',
  'intents',
  'missions',
  'tabs',
  'sessions',
  'recently_closed',
  'memory_artifacts',
  'search_index',
  'dupe_index',
  'settings',
  'ai_jobs',
  'logs',
  'favicons',
  'delta_ring',
  'meta',
] as const;

export type StoreName = (typeof STORE_NAMES)[number];
