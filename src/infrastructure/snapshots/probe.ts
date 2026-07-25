// E2-T08 · part-completeness integrity probe — the §5 sessions-store integrity
// check named by the roadmap completion criterion. Read-only: it NEVER repairs
// (repair drivers act on its report; the journal is the only truth it believes).
//
// For every SnapshotTaken event the device stream holds, the canonical
// expectation is: partCount == ceil(refs/500) AND part rows [0..partCount-1]
// exist AND each row's ids equal the canonical chunk AND styles partition by
// the intersection law AND missionId/takenAt/trigger congruent. Rows with no
// matching event are untracked. Duplicate events for one snapshotId are a
// producer-integrity finding (last-in-stream governs, append-only ordering).
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { DeviceId } from '@/shared-kernel/identity/index.js';
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { chunkRefs, stylesForPart } from './builder.js';
import { readSnapshotPayload, type SnapshotPayloadView } from './payload-schema.js';
import type {
  GroupStyle,
  SessionPartRow,
  SnapshotIntegrityReport,
  SnapshotProbeIssue,
} from './types.js';

export interface SnapshotProbeDeps {
  readonly storage: StorageEnginePort;
  readonly journal: JournalPort;
  readonly deviceId: DeviceId;
}

const stylesEqual = (a: readonly GroupStyle[], b: readonly GroupStyle[]): boolean => {
  if (a.length !== b.length) return false;
  const keyOf = (s: GroupStyle): string =>
    `${s.groupId}|${s.name}|${s.color}|${s.collapsed}|${s.tabOrder.join(',')}`;
  const ka = a.map(keyOf).sort();
  const kb = b.map(keyOf).sort();
  return ka.every((k, i) => k === kb[i]);
};

const checkSnapshot = (
  event: SnapshotPayloadView,
  rows: ReadonlyMap<number, SessionPartRow>,
  issues: SnapshotProbeIssue[],
): void => {
  const chunks = chunkRefs(event.tabRecordRefs);
  // partCount is the completeness contract: it must agree with the chunk law.
  if (event.partCount !== chunks.length) {
    issues.push({
      kind: 'id-mismatch',
      snapshotId: event.snapshotId,
      detail: `partCount ${event.partCount} != chunks ${chunks.length}`,
    });
  }
  for (let partIndex = 0; partIndex < chunks.length; partIndex += 1) {
    const row = rows.get(partIndex);
    if (row === undefined) {
      issues.push({ kind: 'missing-part', snapshotId: event.snapshotId, partIndex });
      continue;
    }
    const expectedIds = chunks[partIndex] ?? [];
    const actualIds = row.tabRecordIds;
    if (actualIds.length !== expectedIds.length) {
      issues.push({
        kind: 'chunk-pattern',
        snapshotId: event.snapshotId,
        partIndex,
        expectedSize: expectedIds.length,
        actualSize: actualIds.length,
      });
    } else {
      const at = actualIds.findIndex((id, i) => id !== expectedIds[i]);
      if (at !== -1) {
        issues.push({
          kind: 'id-mismatch',
          snapshotId: event.snapshotId,
          detail: `part ${partIndex} diverges at index ${at}`,
        });
      }
    }
    const expectedStyles = stylesForPart(event.groupStyles, expectedIds);
    if (!stylesEqual(expectedStyles, row.groupStyles)) {
      issues.push({
        kind: 'style-mismatch',
        snapshotId: event.snapshotId,
        partIndex,
        detail: `part ${partIndex}: expected styles [${expectedStyles
          .map((s) => s.groupId)
          .join(',')}] found [${row.groupStyles.map((s) => s.groupId).join(',')}]`,
      });
    }
    if (row.missionId !== event.missionId) {
      issues.push({
        kind: 'meta-mismatch',
        snapshotId: event.snapshotId,
        partIndex,
        field: 'missionId',
        detail: `${row.missionId} != ${event.missionId}`,
      });
    }
    if (row.takenAt !== event.takenAt) {
      issues.push({
        kind: 'meta-mismatch',
        snapshotId: event.snapshotId,
        partIndex,
        field: 'takenAt',
        detail: `${row.takenAt} != ${event.takenAt}`,
      });
    }
    if (event.trigger !== undefined && row.trigger !== event.trigger) {
      issues.push({
        kind: 'meta-mismatch',
        snapshotId: event.snapshotId,
        partIndex,
        field: 'trigger',
        detail: `${String(row.trigger)} != ${event.trigger}`,
      });
    }
  }
  // Rows beyond the chunk law (or belonging to it) — extras are always wrong.
  for (const partIndex of rows.keys()) {
    if (partIndex >= chunks.length) {
      issues.push({ kind: 'extra-part', snapshotId: event.snapshotId, partIndex });
    }
  }
};

export const probeSnapshotIntegrity = async (
  deps: SnapshotProbeDeps,
): Promise<Result<SnapshotIntegrityReport, LedgeError>> => {
  const read = await deps.journal.readRange({ deviceId: deps.deviceId, fromSeq: 0 });
  if (!read.ok) return read;

  const rowsRead = await deps.storage.txn(['sessions'], 'readonly', (tx) =>
    tx.table<SessionPartRow>('sessions').toArray(),
  );
  if (!rowsRead.ok) return rowsRead;
  const rows = rowsRead.value;

  // Latest-in-stream governs; duplicates are findings (producer integrity).
  const bySnapshot = new Map<string, SnapshotPayloadView>();
  const eventCounts = new Map<string, number>();
  const issues: SnapshotProbeIssue[] = [];
  for (const entry of read.value.events) {
    if (entry.envelope.type !== 'SnapshotTaken') continue;
    const parsed = readSnapshotPayload(entry.envelope.payload);
    if (parsed === null) continue; // registry-gated upstream
    const count = (eventCounts.get(parsed.snapshotId) ?? 0) + 1;
    eventCounts.set(parsed.snapshotId, count);
    bySnapshot.set(parsed.snapshotId, parsed);
  }
  for (const [snapshotId, count] of eventCounts) {
    if (count > 1) issues.push({ kind: 'duplicate-snapshot-event', snapshotId, count });
  }

  const rowsBySnapshot = new Map<string, Map<number, SessionPartRow>>();
  for (const row of rows) {
    const bucket = rowsBySnapshot.get(row.snapshotId) ?? new Map<number, SessionPartRow>();
    bucket.set(row.partIndex, row);
    rowsBySnapshot.set(row.snapshotId, bucket);
  }

  for (const [snapshotId, event] of bySnapshot) {
    checkSnapshot(event, rowsBySnapshot.get(snapshotId) ?? new Map(), issues);
    rowsBySnapshot.delete(snapshotId);
  }
  for (const [snapshotId, bucket] of rowsBySnapshot) {
    for (const partIndex of bucket.keys()) {
      issues.push({ kind: 'untracked-row', snapshotId, partIndex });
    }
  }

  return ok({
    schemaV: 1,
    deviceId: deps.deviceId as string,
    rowsRead: rows.length,
    snapshotsChecked: bySnapshot.size,
    complete: issues.length === 0,
    issues,
  });
};
