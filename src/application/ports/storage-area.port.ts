// E2-T07 · EES §6 StorageAreaPort — chrome.storage local/session for markers + hot
// flags. Implemented only by src/infrastructure/chrome (A-02 adapter containment).
// Consumed by recovery (crash-marker lifecycle, EES-R16) and wired by composition
// roots — never by surfaces, AI, importers, or domain.
//
// Semantics law (ADR-007 §4 crash detection without a shutdown hook):
//   - `local`   — durable across browser restarts; extension-scoped.
//   - `session` — survives SW recycling but NOT browser restart. Absence of a
//                 session marker after relaunch is the browser-termination signal.
//   - Firefox parity: where storage.session is unavailable the port answers typed
//     E_CAPABILITY, never throws and never silently falls back to local (a local
//     fallback would destroy the crash-signal semantics).
//
// Failure class (deliberately small):
//   - E_CAPABILITY      — area unavailable on this browser (e.g. FF session parity)
//   - E_QUOTA           — area quota exceeded (session is quota-capped)
//   - E_CAPABILITY_API  — every other raw rejection (browser drift, profile locks)
//
// Value law: JSON-serializable only (chrome.storage covenant). The port passes
// values through byte-identical; schema validation is the CONSUMER's duty (the
// marker module validates its own records with schemaV + forward tolerance).
// Absent key ⇒ ok(null) — absence is data, not an error.
//
// Performance (EES §6 column): sessionGet ≤2ms hot — it gates the warm-wake
// classification and therefore runs on EVERY boot. Adapters keep it a single
// storage read; no batching, no caching that could serve a stale presence bit.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

export interface StorageAreaPort {
  /** Durable read; absent key ⇒ ok(null). */
  readonly localGet: (key: string) => Promise<Result<unknown, LedgeError>>;
  /** Durable write (overwrite law: latest wins). */
  readonly localSet: (key: string, value: unknown) => Promise<Result<void, LedgeError>>;
  /** Session read; absent key ⇒ ok(null); area unavailable ⇒ err(E_CAPABILITY). */
  readonly sessionGet: (key: string) => Promise<Result<unknown, LedgeError>>;
  /** Session write; area unavailable ⇒ err(E_CAPABILITY). */
  readonly sessionSet: (key: string, value: unknown) => Promise<Result<void, LedgeError>>;
}

export const STORAGE_ERROR_CODES = ['E_CAPABILITY', 'E_QUOTA', 'E_CAPABILITY_API'] as const;
