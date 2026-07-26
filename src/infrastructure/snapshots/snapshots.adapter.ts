// E3-APP · SnapshotsPort production adapter (composition-root seam). Composes the
// M1-stable builder LAW (buildSnapshotPayload proves registry conformance, chunkRefs
// is the single definition of "part", stylesForPart the R4-partition law) and reads
// assembled part rows through the compound sessions pk (index-covered per §2.9).
// The adapter never invents a second definition of part/snapshot: ALL shapes flow
// from builder.ts, ids from the injected generator (test seam), never ambient.
import type {
  GroupStyle,
  SessionPartRow,
  SnapshotBuild,
  SnapshotBuildInput,
  SnapshotsPort,
} from '@/application/ports/snapshots.port.js';
import type { StorageEnginePort, StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { Id, IdGenerator } from '@/shared-kernel/identity/index.js';
import { isId } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { buildSnapshotPayload, chunkRefs, stylesForPart } from './builder.js';

export interface SnapshotsAdapterDeps {
  readonly engine: StorageEnginePort;
  readonly ids: IdGenerator;
}

const SNAPSHOT_PART_INDEX_MAX = Number.MAX_SAFE_INTEGER;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const createSnapshotsAdapter = (deps: SnapshotsAdapterDeps): SnapshotsPort => ({
  build: (input: SnapshotBuildInput): Promise<Result<SnapshotBuild, LedgeError>> => {
    const snapshotId = deps.ids.nextId();
    const built = buildSnapshotPayload({
      snapshotId,
      missionId: input.missionId as Id,
      tabRecordIds: input.tabRecordIds as readonly Id[],
      groupStyles: input.groupStyles.map((s) => ({ ...s, tabOrder: [...s.tabOrder] })),
      takenAt: input.takenAt,
      trigger: input.trigger,
    });
    if (!built.ok) return Promise.resolve(err(built.error));
    const payload = built.value.payload;
    const parts: SessionPartRow[] = chunkRefs(payload.tabRecordRefs).map((refs, partIndex) => ({
      snapshotId,
      partIndex,
      missionId: input.missionId,
      tabRecordIds: [...refs],
      groupStyles: stylesForPart(payload.groupStyles, refs).map((s) => ({
        ...s,
        tabOrder: [...s.tabOrder],
      })),
      takenAt: input.takenAt,
      trigger: input.trigger,
    }));
    return Promise.resolve(
      ok({
        snapshotId,
        payload: {
          snapshotId,
          missionId: input.missionId,
          partCount: payload.partCount,
          tabRecordRefs: [...payload.tabRecordRefs],
          groupStyles: payload.groupStyles.map((s) => ({ ...s, tabOrder: [...s.tabOrder] })),
          takenAt: input.takenAt,
          trigger: input.trigger,
        },
        parts,
      }),
    );
  },

  parts: async (snapshotId: string): Promise<Result<readonly SessionPartRow[], LedgeError>> => {
    if (!isId(snapshotId)) {
      return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'snapshot-id', field: 'snapshotId' }));
    }
    // Compound-pk prefix range — index-covered (§2.9 no-scan law), ordered by partIndex.
    const rows = await deps.engine.txn(['sessions'], 'readonly', (tx) =>
      tx.table<StoredRecord>('sessions').byIndex({
        kind: 'between',
        name: '[snapshotId+partIndex]',
        lower: [snapshotId, 0],
        upper: [snapshotId, SNAPSHOT_PART_INDEX_MAX],
      }),
    );
    if (!rows.ok) return err(rows.error);
    const parts: SessionPartRow[] = rows.value.map((r) => ({
      snapshotId,
      partIndex: num(r['partIndex']),
      missionId: str(r['missionId']),
      tabRecordIds: Array.isArray(r['tabRecordIds']) ? r['tabRecordIds'].map(str) : [],
      groupStyles: Array.isArray(r['groupStyles']) ? (r['groupStyles'] as GroupStyle[]) : [],
      takenAt: num(r['takenAt']),
      // §5 trigger vocabulary; rows pre-dating it (fixture-era bytes) normalize to the
      // neutral historical default — 'auto' — never a flow-specific fabrication.
      trigger:
        r['trigger'] === 'crash' || r['trigger'] === 'manual' || r['trigger'] === 'park'
          ? r['trigger']
          : 'auto',
    }));
    parts.sort((a, b) => a.partIndex - b.partIndex);
    return ok(parts);
  },
});
