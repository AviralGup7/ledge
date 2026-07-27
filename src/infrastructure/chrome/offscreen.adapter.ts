// E3-T07 · EES §6 OffscreenPort over chrome.offscreen (A-02 adapter containment;
// roadmap row "OffscreenPort + workroom skeleton — reason resolution, spawn/close,
// heartbeat lease"). The heartbeat LEASE half of that row is the AI job layer's
// (E8-T01 · EES §3.6 JobHeartbeat law); this seam owns document lifecycle only.
//
// Reason resolution law (Blueprint §9 row 6): spawn reasons come from a VERSIONED
// table (below), never assumed. A browser that rejects a table entry answers
// E_CAPABILITY_API carrying reason-drift fields — the beta-channel soak (E7-T06)
// is the drift witness; adaptation is a table bump in an ADR-noted commit, never
// a silent retry with a different enum.
import type {
  OffscreenCapability,
  OffscreenPort,
  OffscreenSpawnClass,
  WorkroomHandle,
} from '@/application/ports/offscreen.port.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { ChromeOffscreenApi } from './api-surface.js';
import { mapChromeError } from './error-map.js';

export interface OffscreenAdapterDeps {
  /** Structural API seam; production binds chrome.offscreen. */
  readonly api?: ChromeOffscreenApi | undefined;
  /** Workroom document URL relative to the extension root (WXT output path). */
  readonly documentUrl?: string | undefined;
  /** Extension-root-relative URL resolver seam; production binds runtime.getURL. */
  readonly resolveUrl?: ((relativePath: string) => string) | undefined;
  /** Monotonic-ish timestamp seam; production binds Date.now. */
  readonly now?: (() => number) | undefined;
}

const OFFSCREEN_API = 'offscreen';

/** Default workroom document path in the built extension (entrypoints/workroom). */
export const WORKROOM_DOCUMENT_URL = 'workroom.html';

/** Justification strings are part of the review trail — calm, factual, per class. */
const SPAWN_JUSTIFICATION: Readonly<Record<OffscreenSpawnClass, string>> = {
  'ai-jobs': 'Runs local AI jobs that would block the service worker.',
  'index-build': 'Builds the search index off the critical path.',
  'import-parse': 'Parses imported session files off the critical path.',
  'export-render': 'Renders export files off the critical path.',
};

/**
 * Versioned reason table (capability-resolved law). Enum-drift rule: a member the
 * running browser rejects is reported on capability().reasonDrift after the real
 * spawn attempt that observed it; the table then needs an ADR-noted bump — this
 * array is the single review surface for that change.
 */
export const OFFSCREEN_REASON_TABLE: Readonly<Record<OffscreenSpawnClass, readonly string[]>> = {
  'ai-jobs': ['WORKERS'],
  'index-build': ['WORKERS'],
  'import-parse': ['WORKERS'],
  'export-render': ['WORKERS', 'BLOBS'],
};

interface ReasonDriftParse {
  readonly reason: string | undefined;
}

/** Chrome reason-enum rejections name the offending value in the raw message.
 *  Best-effort extraction for drift evidence; absence stays honest (undefined). */
const parseReasonDrift = (raw: string): ReasonDriftParse => {
  const known = new Set(Object.values(OFFSCREEN_REASON_TABLE).flat());
  for (const reason of known) {
    if (raw.includes(reason)) return { reason };
  }
  return { reason: undefined };
};

export function createChromeOffscreenAdapter(deps: OffscreenAdapterDeps = {}): OffscreenPort {
  /** Lazy ambient resolution (MV3 rehydration re-evaluates the global per wake). */
  const api = (): ChromeOffscreenApi | undefined =>
    deps.api ??
    (typeof chrome !== 'undefined'
      ? (chrome.offscreen as unknown as ChromeOffscreenApi)
      : undefined);
  const documentUrl = deps.documentUrl ?? WORKROOM_DOCUMENT_URL;
  const now = deps.now ?? (() => Date.now());
  const resolveUrl =
    deps.resolveUrl ??
    ((relativePath: string): string =>
      typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function'
        ? chrome.runtime.getURL(relativePath)
        : relativePath);

  /** Drift observed from real spawn attempts (capability report, §9-row-6 evidence). */
  const driftLog = new Set<string>();

  const unavailableError = (): LedgeError =>
    ledgeError('E_CAPABILITY_API', { api: OFFSCREEN_API, raw: 'chrome.offscreen unavailable' });

  return {
    hasDocument: async (): Promise<Result<boolean, LedgeError>> => {
      const resolved = api();
      if (resolved === undefined) return err(unavailableError());
      try {
        return ok(await resolved.hasDocument());
      } catch (cause) {
        return err(mapChromeError(cause, OFFSCREEN_API));
      }
    },

    ensureDocument: async ({ spawnClass }): Promise<Result<WorkroomHandle, LedgeError>> => {
      const resolved = api();
      if (resolved === undefined) return err(unavailableError());
      try {
        const already = await resolved.hasDocument();
        if (already) return ok({ spawned: false, ensuredAt: now() });
        // MV3 self-adoption race (two ensures in flight): createDocument rejects
        // "Only a single offscreen document may be created" when the sibling won —
        // that answer is adoption, not failure (idempotent ensure law).
        try {
          await resolved.createDocument({
            url: resolveUrl(documentUrl),
            reasons: OFFSCREEN_REASON_TABLE[spawnClass],
            justification: SPAWN_JUSTIFICATION[spawnClass],
          });
          return ok({ spawned: true, ensuredAt: now() });
        } catch (cause) {
          const adopted = await resolved.hasDocument().catch(() => false);
          if (adopted) return ok({ spawned: false, ensuredAt: now() });
          throw cause;
        }
      } catch (cause) {
        // Enum-drift evidence lands on the capability report; the error carries
        // the same fields so the caller's log line is complete by itself.
        const raw = cause instanceof Error ? cause.message : String(cause);
        const drift = parseReasonDrift(raw);
        if (drift.reason !== undefined) driftLog.add(drift.reason);
        const mapped = mapChromeError(cause, OFFSCREEN_API);
        return err({
          ...mapped,
          details: {
            ...mapped.details,
            spawnClass,
            ...(drift.reason !== undefined ? { reasonDrift: drift.reason } : {}),
          },
        });
      }
    },

    closeDocument: async (): Promise<Result<Record<string, never>, LedgeError>> => {
      const resolved = api();
      if (resolved === undefined) return err(unavailableError());
      try {
        const present = await resolved.hasDocument();
        if (!present) return ok({});
        // Kill race: the browser may have closed it between the two reads —
        // absence on close is the same ok (race-tolerant law).
        await resolved.closeDocument().catch(async (cause: unknown) => {
          const still = await resolved.hasDocument().catch(() => false);
          if (still) throw cause;
        });
        return ok({});
      } catch (cause) {
        return err(mapChromeError(cause, OFFSCREEN_API));
      }
    },

    capability: (): Result<OffscreenCapability, LedgeError> => {
      const resolved = api();
      return ok({
        apiPresent: resolved !== undefined,
        reasonTable: OFFSCREEN_REASON_TABLE,
        reasonDrift: [...driftLog].sort(),
      });
    },
  };
}
