// E2-T05 · browserTabId → ledgeTabId identity resolver (EES §2.1 identity law).
// In-memory authoritative during the SW lifetime; rebuilt from the device stream's
// TabObserved events on wake (hydrate path — the journal is the only durable source).
// Laws:
//   * one browserTabId maps to exactly one ledgeTabId for the hub's lifetime;
//   * minted ids come from the injected IdGenerator (never improvised);
//   * a browserTabId UNKNOWN to the map is minted on first positive observation
//     (created/first-run), never on destructive ones (removed for an unknown tab
//     is skipped upstream — a tab Ledge never saw isn't user truth).
import type { Id, IdGenerator } from '@/shared-kernel/identity/index.js';

export interface IdentityResolution {
  readonly ledgeTabId: Id;
  /** False when the id was already mapped (restart-hydrated or earlier observed). */
  readonly isNew: boolean;
}

export interface TabIdentityMap {
  resolve(browserTabId: number, windowId: number): IdentityResolution;
  /** Lookup only — never mints. */
  get(browserTabId: number): Id | undefined;
  /** Record an identity learned from the journal (hydration path). */
  learn(browserTabId: number, ledgeTabId: Id, windowId: number): void;
  /**
   * Closure finality (truth law): TabClosedExternal is terminal for a ledgeTabId's
   * live episode — late post-close events are skipped upstream, never resurrected.
   * A created-supersede (chrome id-reuse) is the only re-arm.
   */
  close(ledgeTabId: Id): void;
  unclose(ledgeTabId: Id): void;
  isClosed(ledgeTabId: Id): boolean;
  /** Window moves are silently tracked (§4 has no v1 event for them). */
  noteWindow(browserTabId: number, windowId: number): void;
  windowOf(browserTabId: number): number | undefined;
  size(): number;
}

interface IdentityRow {
  readonly ledgeTabId: Id;
  windowId: number;
}

export function createTabIdentityMap(ids: IdGenerator): TabIdentityMap {
  const rows = new Map<number, IdentityRow>();
  /** ledgeTabIds whose latest live episode ended in TabClosedExternal. */
  const closed = new Set<Id>();
  return {
    resolve: (browserTabId, windowId) => {
      const existing = rows.get(browserTabId);
      if (existing !== undefined) {
        existing.windowId = windowId;
        return { ledgeTabId: existing.ledgeTabId, isNew: false };
      }
      const ledgeTabId = ids.nextId();
      rows.set(browserTabId, { ledgeTabId, windowId });
      return { ledgeTabId, isNew: true };
    },
    get: (browserTabId) => rows.get(browserTabId)?.ledgeTabId,
    learn: (browserTabId, ledgeTabId, windowId) => {
      const existing = rows.get(browserTabId);
      if (existing !== undefined) {
        // Hydration race law: a hydrated identity never silently re-mints —
        // journal truth and live truth must agree; if they don't, live wins
        // (the tab is verifiably this browser's) and the discrepancy lands in
        // the reconciliation report (E2-T06 visibility seam).
        existing.windowId = windowId;
        return;
      }
      rows.set(browserTabId, { ledgeTabId, windowId });
    },
    close: (ledgeTabId) => {
      closed.add(ledgeTabId);
    },
    unclose: (ledgeTabId) => {
      closed.delete(ledgeTabId);
    },
    isClosed: (ledgeTabId) => closed.has(ledgeTabId),
    noteWindow: (browserTabId, windowId) => {
      const existing = rows.get(browserTabId);
      if (existing !== undefined) existing.windowId = windowId;
    },
    windowOf: (browserTabId) => rows.get(browserTabId)?.windowId,
    size: () => rows.size,
  };
}
