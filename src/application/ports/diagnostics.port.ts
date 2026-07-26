// E6-T03 · DiagnosticsPort — the EES §6/§2.15 seam (ring buffer 500, redactor,
// probes registry, export bundle; adr note: docs/adr-notes/e6-diagnostics.md).
// Laws (ADR-027/028, EES §12):
//   · NO telemetry, ever — every byte this port handles stays in the local logs
//     ring (IDB) and leaves the device only on an explicit user gesture (the
//     rescue console's download); egress-guard stays ∅ by construction.
//   · REDACTION DEFAULT-ON: addresses (URLs/domains) are hashed at WRITE time
//     unless the include-addresses flip is active; the flip auto-decays ≤24h
//     (read-side expiry — no timers, no SW-lifetime bets).
//   · REDACTOR FAILURE ⇒ ENTRY DROPPED, never passed through (fail-drop law);
//     the boot self-test probes this and a degraded redactor shows on the
//     registry's lifecycle probe, never rides along silently.
//   · Unified typed observability ring (user-ruled F4): command lifecycle AND
//     diagnostic events share ONE timeline with one retention policy (500,
//     drop-oldest) — the console renders one story, not split stores.
//   · Probe catalog is REGISTRY-complete per EES §12 (user-ruled F2): all ten
//     §12 probe definitions exist at v1 with honest lifecycle status — v1.1-only
//     probes (AI lanes, offscreen spawn) report 'unwired', never fake green.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** Ring entry classes (the console's timeline filters ride these). 'diag' is the
 *  adapter lifecycle class (self-test, include-flip grants). */
export type DiagKind = 'command' | 'scan' | 'bundle' | 'probe' | 'diag';
export type DiagLevel = 'debug' | 'info' | 'warn' | 'error';

/** One fire-and-forget observability event (drop-safe by law — the queue is
 *  bounded and SW death may orphan queued entries; diagnostics are never truth). */
export interface DiagEvent {
  readonly level: DiagLevel;
  readonly kind: DiagKind;
  /** Stable machine token (never display copy — surfaces render kind/level). */
  readonly msg: string;
  /** Primitive-only context; redacted at write time per the flip. */
  readonly fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export interface DiagProbeRow {
  /** Catalog identifier (stable across versions — registry v1 pinned by tests). */
  readonly name: string;
  /** Lifecycle honesty (user-ruled F2): 'unwired' renders neutral, never green. */
  readonly wired: boolean;
  readonly status: 'ok' | 'warn' | 'fail' | 'unwired';
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/** §5 logs-row value shape (slot-keyed ring; `fields` pre-redacted, ctxHash the
 *  tamper-sight digest of the serialized fields). */
export interface DiagRingRow {
  readonly slot: number;
  readonly at: number;
  readonly level: DiagLevel;
  readonly kind: DiagKind;
  readonly msg: string;
  readonly fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly ctxHash: string;
}

/** The export bundle as assembled (bundleId doubles as the ring ref). */
export interface DiagBundle {
  readonly bundleId: string;
  readonly createdAt: number;
  readonly includeAddresses: boolean;
  readonly size: number;
  /** The assembled document (JSON string) — local-only; download by gesture. */
  readonly json: string;
}

export interface DiagnosticsPort {
  /** Fire-and-forget unified-ring write: queued, redacted, batched-flush (EES §6
   *  ≤1ms/log amortized). Redactor failure ⇒ the entry is DROPPED (never raw). */
  readonly log: (event: DiagEvent) => void;
  /** Force the pending queue to durable storage (export/self-test/test seams). */
  readonly flush: () => Promise<Result<void, LedgeError>>;
  /** Durable diagnostic row with a cite-able ref (scan reports, bundle receipts). */
  readonly report: (
    kind: DiagKind,
    event: Omit<DiagEvent, 'kind'>,
  ) => Promise<Result<string, LedgeError>>;
  /** Timeline read for the console (newest first; bundle payloads stripped). */
  readonly ringDump: (limit: number) => Promise<Result<readonly DiagRingRow[], LedgeError>>;
  /** Include-addresses flip (ADR-027): active ⇐ now < granted-until. Read-side
   *  decay — stale grants expire by observation, not by alarm. */
  readonly includeAddressesActive: () => Promise<Result<boolean, LedgeError>>;
  /** Grant (true ⇒ +24h window) or revoke (false ⇒ immediate) the flip. */
  readonly grantIncludeAddresses: (include: boolean) => Promise<Result<void, LedgeError>>;
  /** Boot redactor self-test (EES §5 logs row): proves hash-stability + fail-drop
   *  against a sabotage seam; a degraded result flags the lifecycle probe. */
  readonly selfTest: () => Promise<Result<'ok' | 'degraded', LedgeError>>;
  /** EES §12 probe registry run (catalog-complete; unwired rows honest). */
  readonly runProbes: () => Promise<Result<readonly DiagProbeRow[], LedgeError>>;
  /** Assemble the diagnostics bundle NOW (redaction posture = current flip).
   *  Budget law: ≤10s end-to-end (EES §7.10). */
  readonly exportBundle: () => Promise<Result<DiagBundle, LedgeError>>;
  /** The most recent assembled bundle still resident in the ring (null when the
   *  ring rolled past it — 'available' honesty for the download gesture). */
  readonly lastBundle: () => Promise<Result<DiagBundle | null, LedgeError>>;
}
