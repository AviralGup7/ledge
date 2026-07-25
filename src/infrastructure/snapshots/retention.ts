// E2-T08 · snapshot retention policy (PURE) — §5 sessions row's retention law:
// "rolling 30d per mission (newest preserved)". The sweep that EXECUTES the
// plan lands with the maintenance windows (E3-T04 alarms); the law itself is
// testable today, and T10's purge-law suites consume it.
//
// Semantics per mission, evaluated independently:
//   keep  — the NEWEST snapshot of the mission, always (recency of last truth
//           is never subject to age).
//   keep  — every other snapshot whose age < retentionDays.
//   purge — the rest. Order ties break deterministically by snapshotId so the
//           plan is a pure function of its input.

/** Default from the §5 row (30 days, per mission, newest preserved). */
export const SNAPSHOT_RETENTION_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export interface SnapshotRetentionInput {
  readonly snapshotId: string;
  readonly missionId: string;
  readonly takenAt: number;
}

export interface SnapshotRetentionPlan {
  readonly keep: readonly string[];
  readonly purge: readonly string[];
}

export const planRetention = (
  snapshots: readonly SnapshotRetentionInput[],
  now: number,
  retentionDays: number = SNAPSHOT_RETENTION_DAYS,
): SnapshotRetentionPlan => {
  const byMission = new Map<string, SnapshotRetentionInput[]>();
  for (const snap of snapshots) {
    const list = byMission.get(snap.missionId) ?? [];
    list.push(snap);
    byMission.set(snap.missionId, list);
  }
  const keep: string[] = [];
  const purge: string[] = [];
  for (const list of byMission.values()) {
    const newest = [...list].sort(
      (a, b) => b.takenAt - a.takenAt || (a.snapshotId < b.snapshotId ? -1 : 1),
    );
    let firstOfMission = true;
    for (const snap of newest) {
      if (firstOfMission) {
        keep.push(snap.snapshotId); // newest preserved, unconditionally
        firstOfMission = false;
        continue;
      }
      if (now - snap.takenAt < retentionDays * DAY_MS) keep.push(snap.snapshotId);
      else purge.push(snap.snapshotId);
    }
  }
  return { keep: keep.sort(), purge: purge.sort() };
};
