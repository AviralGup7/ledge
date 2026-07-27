// E3-T07 · EES §6 OffscreenPort — the workroom document lifecycle seam (ADR-008).
// Implemented in infrastructure/chrome; consumed by the AI job worker-host (E8-T01)
// and the parse/render lanes (E5/E8 follow-ons). The port carries ONLY document
// lifecycle — capability detection, reason resolution, spawn/close — never job
// payloads (those ride §3.6 wire messages through the runtime channel).
//
// Laws encoded here:
//  * SW IS SOLE SPAWNER/CLOSER (EES §3.6 ownership law) — no other context may
//    hold this port; composition wires it into the background graph only.
//  * REASONS ARE CAPABILITY-RESOLVED, never assumed (Blueprint §9 row 6 "respawn
//    w/ capability-resolved reasons"): a reason the running browser rejects is an
//    honest E_CAPABILITY_API with drift fields, never a crash, never a retry loop.
//    The enum-drift class is what the beta-channel soak (E7-T06) watches.
//  * ABSENT IS NOT AN ERROR: hasDocument and closeDocument are race-tolerant —
//    closing an absent document answers ok (same law as tabs.remove already-gone).
//  * THE DOCUMENT IS DISPOSABLE: the browser may kill it at will; nothing durable
//    may live behind this port. Kill-recovery is the job lease layer's law
//    (E8-T01), not this seam's.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** Why the workroom is being spawned. Each class maps to a chrome-reason set in
 *  the adapter's versioned reason table (capability-resolved, never assumed). */
export type OffscreenSpawnClass = 'ai-jobs' | 'index-build' | 'import-parse' | 'export-render';

/** Capability report: what the running browser offers, read-only and honest.
 *  `reasonDrift` lists any enum members our table knows but the running browser
 *  rejected — observed lazily from real spawn attempts (never by probe-spawning;
 *  spawning to observe is invasive and the law above forbids it). */
export interface OffscreenCapability {
  readonly apiPresent: boolean;
  /** Chrome reasons the adapter would request for each spawn class (versioned table). */
  readonly reasonTable: Readonly<Record<OffscreenSpawnClass, readonly string[]>>;
  /** Reason strings rejected by the running browser so far (enum-drift evidence). */
  readonly reasonDrift: readonly string[];
}

/** A live (or adopted) workroom document handle. */
export interface WorkroomHandle {
  /** True when this call created the document; false when it already existed. */
  readonly spawned: boolean;
  /** Adapter-side monotonic timestamp (ms) of the ensure call. */
  readonly ensuredAt: number;
}

export interface OffscreenPort {
  /** Document presence. Race-tolerant by definition (a kill may land at any time). */
  readonly hasDocument: () => Promise<Result<boolean, LedgeError>>;
  /**
   * Spawn-if-needed for the given class. Idempotent: an existing document is
   * adopted ({spawned:false}) — chrome refuses a second document and the law
   * treats that as success-with-adoption, never an error.
   */
  readonly ensureDocument: (input: {
    readonly spawnClass: OffscreenSpawnClass;
  }) => Promise<Result<WorkroomHandle, LedgeError>>;
  /** Close the document if present. Absent ⇒ ok (race-tolerant, kill-tolerant). */
  readonly closeDocument: () => Promise<Result<Record<string, never>, LedgeError>>;
  /** Read-only capability posture (see OffscreenCapability's laws). */
  readonly capability: () => Result<OffscreenCapability, LedgeError>;
}
