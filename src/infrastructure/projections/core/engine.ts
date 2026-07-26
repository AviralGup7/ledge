// E2-T03 · projection engine (EES §2.10): event → read-model driver with watermarks,
// dirty marking, chunked (resumable) txns, and §3.5 delta publication. Every law is on
// the engine, not on individual projectors: idempotent-by-watermark skipping, per-device
// (seq, batchIndex) order, chunked-txn resume-after-kill, rebuild determinism.
import type {
  ApplyReport,
  DeltaOp,
  DeltaSubscriber,
  ProjectorDef,
  ProjectionEnginePort,
  ProjectionStatus,
  ProjectionViewStatus,
  RebuildReport,
  ViewDeltaFrame,
  ViewName,
  Watermark,
} from '@/application/ports/projection-engine.port.js';
import type {
  StorageEnginePort,
  StorageKey,
  StoreName,
  StoredRecord,
  TxScope,
} from '@/application/ports/storage-engine.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { META_JOURNAL_HEADS_KEY } from '@/infrastructure/journal/index.js';
import {
  APPLY_CHUNK,
  FRAME_OPS_CAP,
  META_WATERMARKS_KEY,
  watermarkKeyFor,
  type WatermarkRow,
  type WatermarkTable,
} from './types.js';

type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

/** One event positioned in its device stream (batchIndex from journal or derived). */
type Positioned = {
  readonly envelope: EventEnvelope;
  readonly deviceId: DeviceId;
  readonly seq: number;
  readonly batchIndex: number;
};

export interface ProjectionEngineDeps {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly projectors: readonly ProjectorDef[];
  /** Hub's channel seam (§3.5); engine emits committed frames only. */
  readonly onDelta?: DeltaSubscriber | undefined;
}

const cmpPos = (
  a: { seq: number; batchIndex: number },
  b: { seq: number; batchIndex: number },
): number => a.seq - b.seq || a.batchIndex - b.batchIndex;

const lessOrEqual = (
  p: { seq: number; batchIndex: number },
  w: { seq: number; batchIndex: number },
): boolean => cmpPos(p, w) <= 0;

export function createProjectionEngine(deps: ProjectionEngineDeps): ProjectionEnginePort {
  const { engine, journal, projectors, onDelta } = deps;

  const storesOf = (defs: readonly ProjectorDef[]): StoreName[] => [
    ...new Set<StoreName>(defs.map((d) => d.store)),
  ];

  const readWatermarkTable = async (tx: TxScope): Promise<WatermarkTable> => {
    const row = await tx.table<MetaRow>('meta').get(META_WATERMARKS_KEY);
    return (row?.value ?? {}) as WatermarkTable;
  };

  /**
   * Drive one device's positioned events through all (or one) projectors, in
   * APPLY_CHUNK-sized single txns. Frames publish POST-commit (they describe durable
   * truth; §3.5 stream recovery on gaps is the hub's ResyncRequired flow, not ours).
   */
  const driveDevice = async (
    events: readonly Positioned[],
    onlyView: ViewName | undefined,
    report: { applied: number; skippedBelowWatermark: number; dirtied: ViewName[] },
  ): Promise<Result<void, LedgeError>> => {
    const active = projectors.filter((p) => onlyView === undefined || p.view === onlyView);
    if (active.length === 0 || events.length === 0) return ok(undefined);
    const scope: StoreName[] = ['meta', ...storesOf(active)];
    const deviceId = events.at(0)?.deviceId;
    if (deviceId === undefined) return ok(undefined);

    for (let start = 0; start < events.length; start += APPLY_CHUNK) {
      const chunk = events.slice(start, start + APPLY_CHUNK);
      const frames: { view: ViewName; watermark: Watermark; ops: DeltaOp[] }[] = [];
      const committed = await engine.txn(scope, 'readwrite', async (tx) => {
        const wmTable = await readWatermarkTable(tx);
        const opsByView = new Map<ViewName, DeltaOp[]>();

        for (const positioned of chunk) {
          for (const projector of active) {
            const wmKey = watermarkKeyFor(projector.view, deviceId as string);
            const wm = wmTable[wmKey];
            if (wm !== undefined && wm.dirty) continue; // dirty law: frozen until rebuild
            const zeroRow: WatermarkRow = {
              view: projector.view,
              projectorV: projector.projectorV,
              dirty: false,
              deviceId,
              seq: 0,
              batchIndex: 0,
            };
            const floor = wm ?? zeroRow;
            if (projector.projectorV === floor.projectorV && lessOrEqual(positioned, floor)) {
              report.skippedBelowWatermark += 1;
              continue;
            }
            // projectorV bump ⇒ the view is due a rebuild; ops still apply, version rides.
            try {
              const readRow = (key: string): Promise<StoredRecord | undefined> =>
                tx.table<StoredRecord>(projector.store).get(key);
              const ops = await projector.project(positioned.envelope, readRow);
              for (const op of ops) {
                const table = tx.table<StoredRecord>(projector.store);
                if (op.kind === 'upsert') await table.put(op.record);
                if (op.kind === 'remove') await table.delete(op.key);
                if (op.kind === 'patch') {
                  const current = await table.get(op.key);
                  await table.put({
                    ...(current ?? {}),
                    ...op.fields,
                    ...primaryKeyOf(projector, op.key),
                  });
                }
                const list = opsByView.get(projector.view) ?? [];
                list.push(op);
                opsByView.set(projector.view, list);
              }
            } catch {
              // §2.10 failure law: projector throw ⇒ mark dirty, peers continue.
              if (!report.dirtied.includes(projector.view)) {
                report.dirtied.push(projector.view);
              }
              wmTable[wmKey] = { ...(wmTable[wmKey] ?? zeroRow), dirty: true };
              continue;
            }
            wmTable[wmKey] = {
              ...(floor as WatermarkRow),
              projectorV: projector.projectorV,
              dirty: false,
              deviceId,
              seq: positioned.seq,
              batchIndex: positioned.batchIndex,
            };
          }
          report.applied += 1;
        }

        await tx.table<MetaRow>('meta').put({ key: META_WATERMARKS_KEY, value: wmTable });
        for (const [view, ops] of opsByView) {
          const wmRow = wmTable[watermarkKeyFor(view, deviceId as string)];
          const watermark: Watermark = {
            deviceId,
            seq: wmRow?.seq ?? 0,
            batchIndex: wmRow?.batchIndex ?? 0,
          };
          frames.push({ view, watermark, ops });
        }
        return undefined;
      });
      if (!committed.ok) return committed;

      // Post-commit delta publication, chunked per §3.5's ≤500 ops/frame cap.
      if (onDelta !== undefined) {
        for (const frame of frames) {
          for (let i = 0; i < frame.ops.length; i += FRAME_OPS_CAP) {
            const slice = frame.ops.slice(i, i + FRAME_OPS_CAP);
            const shaped: ViewDeltaFrame = {
              view: frame.view,
              watermark: frame.watermark,
              ops: slice,
            };
            onDelta(shaped);
          }
        }
      }
    }
    return ok(undefined);
  };

  const position = (events: readonly EventEnvelope[]): Positioned[] => {
    // Per-device ordering: seq is the law; input order breaks same-seq ties (mirrors
    // the journal's own (seq, batchIndex) sort — readRange emits entries in stream
    // order, so a replayed stream gets identical batchIndexes here).
    const byDevice = new Map<string, EventEnvelope[]>();
    for (const e of events) {
      const key = e.hlc.deviceId as string;
      const list = byDevice.get(key) ?? [];
      list.push(e);
      byDevice.set(key, list);
    }
    const out: Positioned[] = [];
    for (const [deviceId, list] of byDevice) {
      const sorted = list
        .map((envelope, inputIdx) => ({ envelope, inputIdx }))
        .sort((a, b) => a.envelope.hlc.seq - b.envelope.hlc.seq || a.inputIdx - b.inputIdx);
      let idxWithinSeq = -1;
      let prevSeq = -1;
      for (const { envelope } of sorted) {
        idxWithinSeq = envelope.hlc.seq === prevSeq ? idxWithinSeq + 1 : 0;
        prevSeq = envelope.hlc.seq;
        out.push({
          envelope,
          deviceId: deviceId as DeviceId,
          seq: envelope.hlc.seq,
          batchIndex: idxWithinSeq,
        });
      }
    }
    return out.sort(cmpPos);
  };

  const applyPositioned = async (
    byDevice: Map<string, Positioned[]>,
    onlyView: ViewName | undefined,
  ): Promise<Result<ApplyReport, LedgeError>> => {
    const report = { applied: 0, skippedBelowWatermark: 0, dirtied: [] as ViewName[] };
    for (const list of byDevice.values()) {
      const r = await driveDevice(list, onlyView, report);
      if (!r.ok) return r;
    }
    return ok(report);
  };

  return {
    async apply(events: readonly EventEnvelope[]): Promise<Result<ApplyReport, LedgeError>> {
      const positioned = position(events);
      const byDevice = new Map<string, Positioned[]>();
      for (const p of positioned) {
        const key = p.deviceId as string;
        const list = byDevice.get(key) ?? [];
        list.push(p);
        byDevice.set(key, list);
      }
      return applyPositioned(byDevice, undefined);
    },

    async applyFromJournal(deviceId: DeviceId): Promise<Result<ApplyReport, LedgeError>> {
      const read = await journal.readRange({ deviceId, fromSeq: 1 });
      if (!read.ok) return read;
      const positioned: Positioned[] = read.value.events.map((e) => ({
        envelope: e.envelope,
        deviceId,
        seq: e.seq,
        batchIndex: e.batchIndex,
      }));
      return applyPositioned(new Map([[deviceId as string, positioned]]), undefined);
    },

    async rebuild(view: ViewName): Promise<Result<RebuildReport, LedgeError>> {
      const projector = projectors.find((p) => p.view === view);
      if (projector === undefined) {
        return {
          ok: false,
          error: ledgeError('E_FORMAT_UNKNOWN', { what: 'projection-view', view }),
        };
      }
      // Law: wipe rows + watermarks, then replay. Only the target view is touched.
      const wiped = await engine.txn([projector.store, 'meta'], 'readwrite', async (tx) => {
        const table = tx.table<StoredRecord>(projector.store);
        const rows = await table.toArray();
        await table.deleteMany(
          rows.map((r) => primaryKeyOfRow(projector, r)).filter((k): k is StorageKey => k !== null),
        );
        const wmTable = await readWatermarkTable(tx);
        for (const key of Object.keys(wmTable)) {
          if (wmTable[key]?.view !== view) continue;
          const row = wmTable[key];
          if (row !== undefined) wmTable[key] = { ...row, seq: 0, batchIndex: 0, dirty: false };
        }
        await tx.table<MetaRow>('meta').put({ key: META_WATERMARKS_KEY, value: wmTable });
        return undefined;
      });
      if (!wiped.ok) return wiped;

      // Discover device streams from the journal heads row and replay each one.
      const headsRead = await engine.txn(['meta'], 'readonly', (tx) =>
        tx.table<MetaRow>('meta').get(META_JOURNAL_HEADS_KEY),
      );
      if (!headsRead.ok) return headsRead;
      const heads = (headsRead.value?.value ?? {}) as Record<string, unknown>;
      let eventsApplied = 0;
      for (const deviceId of Object.keys(heads).sort()) {
        const read = await journal.readRange({ deviceId: deviceId as DeviceId, fromSeq: 1 });
        if (!read.ok) return read;
        const positioned: Positioned[] = read.value.events.map((e) => ({
          envelope: e.envelope,
          deviceId: deviceId as DeviceId,
          seq: e.seq,
          batchIndex: e.batchIndex,
        }));
        const r = await applyPositioned(new Map([[deviceId, positioned]]), view);
        if (!r.ok) return r;
        eventsApplied += read.value.events.length;
      }
      return ok({ view, eventsApplied });
    },

    async status(): Promise<Result<ProjectionStatus, LedgeError>> {
      return engine.txn(['meta'], 'readonly', async (tx) => {
        const wmTable = await readWatermarkTable(tx);
        const views: ProjectionViewStatus[] = projectors.map((p) => {
          const rows = Object.values(wmTable).filter((r) => r.view === p.view);
          return {
            view: p.view,
            projectorV: p.projectorV,
            dirty: rows.some((r) => r.dirty),
            watermarks: rows.map((r) => ({
              deviceId: r.deviceId,
              seq: r.seq,
              batchIndex: r.batchIndex,
            })),
          };
        });
        return { views };
      });
    },
  };
}

/** pk field per view projector (wipe + patch-identity law). The projector DEF declares
 *  it (keyField — registry-growth law); the legacy per-store fallback covers def-free
 *  fixtures. */
const primaryKeyFieldOf = (projector: ProjectorDef): string => {
  if (projector.keyField !== undefined) return projector.keyField;
  switch (projector.store) {
    case 'missions':
      return 'missionId';
    case 'recently_closed':
      return 'entryId';
    default:
      return 'missionId';
  }
};

/**
 * Row→primary key per view store (rebuild wipe law). Compound-pk stores like
 * 'sessions' ([snapshotId+partIndex]) key by TUPLE, not by a single field —
 * E2-T08: without this the wipe-address was a single field and the compound
 * store silently kept its rows across rebuilds.
 */
const primaryKeyOfRow = (projector: ProjectorDef, row: StoredRecord): StorageKey | null => {
  if (projector.store === 'sessions') {
    const snapshotId = row['snapshotId'];
    const partIndex = row['partIndex'];
    return typeof snapshotId === 'string' && typeof partIndex === 'number'
      ? [snapshotId, partIndex]
      : null;
  }
  const k = row[primaryKeyFieldOf(projector)];
  return typeof k === 'string' && k.length > 0 ? k : null;
};

/** Patch law: the store's pk field must survive the merge (shallow patch never drops it). */
const primaryKeyOf = (projector: ProjectorDef, key: string): Record<string, unknown> => {
  if (projector.store === 'sessions') return {}; // compound pk: patch addressing is N/A
  return { [primaryKeyFieldOf(projector)]: key };
};
