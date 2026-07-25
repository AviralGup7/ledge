// Missions view projector (E2-T03 · EES §5 'missions' row, §4 MissionFormed family).
// Reference projector for the engine's law suites; use-case richness lands E3+.
// Every rule is upsert-idempotent; everything on the row derives from the journal.
import type { DeltaOp, ProjectorDef } from '@/application/ports/projection-engine.port.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';

/** §5 'missions' row (view shape; additive fields allowed forward). Type alias for
 *  StoredRecord's implicit index signature. */
export type MissionViewRow = {
  readonly missionId: string;
  readonly name: string;
  readonly namedBy: string;
  readonly state: 'live' | 'archived';
  readonly concluded: boolean;
  readonly tabIds: readonly string[];
  readonly createdAt: number;
  readonly lastActiveAt: number;
};

const asIds = (v: unknown): readonly string[] => (Array.isArray(v) ? (v as readonly string[]) : []);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const unionTab = (row: MissionViewRow, tabId: string): MissionViewRow => ({
  ...row,
  tabIds: row.tabIds.includes(tabId) ? row.tabIds : [...row.tabIds, tabId],
});

const withoutTab = (row: MissionViewRow, tabId: string): MissionViewRow => ({
  ...row,
  tabIds: row.tabIds.filter((t) => t !== tabId),
});

/**
 * Guard precision is the dirty-law contract: unionTab/withoutTab DEREFERENCE
 * tabIds, so a "row" here must actually be a full view row. The engine's patch
 * law auto-materializes patch-partial rows (a MissionRenamed patch on a
 * never-formed mission keys a name-only record) — checking missionId alone
 * passes those and the tabIds deref throws the view into dirty. Lawful catalog
 * streams must never dirty the view (regression: fc seed -159411701,
 * rename-then-assign before formation). Patch-partials read as NOT-a-row and
 * take the forward-tolerance provisional path like any missing row.
 */
const isMissionRow = (r: StoredRecord | undefined): r is StoredRecord & MissionViewRow =>
  r !== undefined && typeof r['missionId'] === 'string' && Array.isArray(r['tabIds']);

export const missionsProjector: ProjectorDef = {
  view: 'missions',
  store: 'missions',
  projectorV: 1,
  async project(event, read): Promise<readonly DeltaOp[]> {
    const p = event.payload as Record<string, unknown>;
    const wall = event.hlc.wallClock;
    switch (event.type) {
      case 'MissionFormed': {
        const missionId = str(p['missionId']);
        const row: MissionViewRow = {
          missionId,
          name: str(p['name']),
          namedBy: str(p['namedBy']),
          state: 'live',
          concluded: false,
          tabIds: asIds(p['tabIds']),
          createdAt: wall,
          lastActiveAt: wall,
        };
        // Idempotent by missionId (registry law): re-forming upserts the same base row.
        return [{ kind: 'upsert', key: missionId, record: row }];
      }
      case 'MissionRenamed': {
        const missionId = str(p['missionId']);
        return [
          {
            kind: 'patch',
            key: missionId,
            fields: { name: str(p['name']), lastActiveAt: wall },
          },
        ];
      }
      case 'TabAssigned':
      case 'TabMoved': {
        const tabId = str(p['tabId']);
        const missionId = str(p['missionId']);
        const fromMissionId = str(p['fromMissionId']);
        const ops: DeltaOp[] = [];
        if (event.type === 'TabMoved' && fromMissionId.length > 0 && fromMissionId !== missionId) {
          const from = await read(fromMissionId);
          if (isMissionRow(from)) {
            ops.push({ kind: 'upsert', key: fromMissionId, record: withoutTab(from, tabId) });
          }
        }
        const current = await read(missionId);
        if (isMissionRow(current)) {
          ops.push({ kind: 'upsert', key: missionId, record: unionTab(current, tabId) });
        } else {
          // Forward tolerance: membership before formation (cross-device order skew in
          // v2) materializes a provisional row the real formation later overwrites.
          ops.push({
            kind: 'upsert',
            key: missionId,
            record: {
              missionId,
              name: '',
              namedBy: 'system',
              state: 'live',
              concluded: false,
              tabIds: [tabId],
              createdAt: wall,
              lastActiveAt: wall,
            } satisfies MissionViewRow,
          });
        }
        return ops;
      }
      case 'MissionArchived': {
        const missionId = str(p['missionId']);
        return [
          { kind: 'patch', key: missionId, fields: { state: 'archived', lastActiveAt: wall } },
        ];
      }
      default:
        return [];
    }
  },
};
