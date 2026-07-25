// E2-T08 · tolerant SnapshotTaken payload readers (projector + probe share them —
// the same byte means the same row everywhere). Registry validatePayload gates the
// append path; these cover projection/projection-rebuild/foreign-fixture reads.
import { SNAPSHOT_TRIGGERS, type GroupStyle, type SnapshotTrigger } from './types.js';

export const asStrings = (v: unknown): readonly string[] =>
  Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as readonly string[]) : [];

export const asStyles = (v: unknown): readonly GroupStyle[] => {
  if (!Array.isArray(v)) return [];
  const out: GroupStyle[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['groupId'] !== 'number') continue;
    out.push({
      groupId: r['groupId'],
      name: typeof r['name'] === 'string' ? r['name'] : '',
      color: typeof r['color'] === 'string' ? r['color'] : '',
      collapsed: r['collapsed'] === true,
      tabOrder: asStrings(r['tabOrder']),
    });
  }
  return out;
};

export const asTrigger = (v: unknown): SnapshotTrigger | undefined =>
  typeof v === 'string' && (SNAPSHOT_TRIGGERS as readonly string[]).includes(v)
    ? (v as SnapshotTrigger)
    : undefined;

export interface SnapshotPayloadView {
  readonly snapshotId: string;
  readonly missionId: string;
  readonly partCount: number;
  readonly tabRecordRefs: readonly string[];
  readonly groupStyles: readonly GroupStyle[];
  readonly takenAt: number;
  readonly trigger: SnapshotTrigger | undefined;
}

/** Read one SnapshotTaken payload. null when the identity fields are unusable
 *  (ref-less garbage degrades to empty refs — chunk law handles it). */
export const readSnapshotPayload = (payload: unknown): SnapshotPayloadView | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const snapshotId = typeof p['snapshotId'] === 'string' ? p['snapshotId'] : '';
  if (snapshotId === '') return null;
  return {
    snapshotId,
    missionId: typeof p['missionId'] === 'string' ? p['missionId'] : '',
    partCount: typeof p['partCount'] === 'number' ? p['partCount'] : 0,
    tabRecordRefs: asStrings(p['tabRecordRefs']),
    groupStyles: asStyles(p['groupStyles']),
    takenAt: typeof p['takenAt'] === 'number' ? p['takenAt'] : 0,
    trigger: asTrigger(p['trigger']),
  };
};
