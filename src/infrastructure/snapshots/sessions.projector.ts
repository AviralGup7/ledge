// E2-T08 · SessionsView projector (E2-T03 engine family) — materializes the
// §5 'sessions' store from SnapshotTaken events: canonical 500-chunks become
// one row per part, styles partitioned by intersection, trigger carried
// verbatim (present ⇒ stored, absent ⇒ omitted; never fabricated).
//
// Idempotence law (engine runs apply-twice paths, ADR-011 rebuilds, chunked
// resume): the same event always derives the same upserts — payload is
// immutable truth and parts are a pure function of it. Stale rows beyond
// partCount are NOT the projector's concern (a payload cannot shrink):
// rebuild wipes the view (compound-pk law), the integrity probe names any
// torn row repair-driving is for.
import type { DeltaOp, ProjectorDef } from '@/application/ports/projection-engine.port.js';
import { chunkRefs, stylesForPart } from './builder.js';
import { readSnapshotPayload } from './payload-schema.js';
import type { SessionPartRow } from './types.js';

export const sessionsProjector: ProjectorDef = {
  view: 'sessions',
  store: 'sessions',
  projectorV: 1,
  async project(event): Promise<readonly DeltaOp[]> {
    if (event.type !== 'SnapshotTaken') return [];
    const parsed = readSnapshotPayload(event.payload);
    if (parsed === null) return []; // registry validation normally gates this
    const chunks = chunkRefs(parsed.tabRecordRefs);
    const ops: DeltaOp[] = [];
    for (let partIndex = 0; partIndex < chunks.length; partIndex += 1) {
      const partRefs = chunks[partIndex] ?? [];
      const row: SessionPartRow = {
        snapshotId: parsed.snapshotId,
        partIndex,
        missionId: parsed.missionId,
        tabRecordIds: partRefs,
        groupStyles: stylesForPart(parsed.groupStyles, partRefs),
        takenAt: parsed.takenAt,
        ...(parsed.trigger !== undefined ? { trigger: parsed.trigger } : {}),
      };
      // Compound pk rides in the row; the delta key is the canonical address.
      ops.push({ kind: 'upsert', key: `${parsed.snapshotId}/${partIndex}`, record: row });
    }
    return ops;
  },
};
