// Recently-closed view projector (E2-T03 · EES §5 'recently_closed' row contract:
// entryId → {tabSnapshot, closedAt, source:external|reconciled}; Blueprint: separate
// store, explicit refresh semantics — never folded out of another projection).
import type { DeltaOp, ProjectorDef } from '@/application/ports/projection-engine.port.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';

/** §5 'recently_closed' row — declaration lives at the application port seam
 *  (view-rows); re-exported here for existing import sites. */
export type { RecentlyClosedRow } from '@/application/ports/view-rows.js';
import type { RecentlyClosedRow } from '@/application/ports/view-rows.js';

/** Deterministic entry ids (≤1 open slot per tab; a fresh close re-enters it). */
export const entryIdForTab = (ledgeTabId: string): string => `${ledgeTabId}:rc`;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const maybeId = (v: unknown): string | undefined => {
  const s = str(v);
  return s.length > 0 ? s : undefined;
};

export const recentlyClosedProjector: ProjectorDef = {
  view: 'recentlyClosed',
  store: 'recently_closed',
  keyField: 'entryId',
  projectorV: 1,
  async project(event): Promise<readonly DeltaOp[]> {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'TabClosedExternal': {
        const tabId = str(p['ledgeTabId']);
        const row: RecentlyClosedRow = {
          entryId: entryIdForTab(tabId),
          tabId,
          closedAt: typeof p['closedAt'] === 'number' ? p['closedAt'] : event.hlc.wallClock,
          source: 'external',
          missionId: maybeId(p['lastMissionId']),
          snapshotRef: maybeId(p['snapshotRef']),
        };
        return [{ kind: 'upsert', key: row.entryId, record: row }];
      }
      case 'TrashRestored': {
        // Restoration clears the slot for that tab (kind field carries 'tab' etc.).
        const id = str(p['id']);
        if (str(p['kind']) !== 'tab' || id.length === 0) return [];
        return [{ kind: 'remove', key: entryIdForTab(id) }];
      }
      default:
        return [];
    }
  },
};

export const isRecentlyClosedRow = (
  r: StoredRecord | undefined,
): r is StoredRecord & RecentlyClosedRow => r !== undefined && typeof r['entryId'] === 'string';
