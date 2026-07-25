// E2-T01 · journal scanner/checkpoint store (EES §2.8, ADR-004): CRC walks + chain law
// verification + meta.checkpointPtrs stamping. The pure core (verifyDeviceChain) decides
// everything; the IO shell only reads rows — policy disclosure lives with recovery
// (E2-T06), the journal's sworn duty is precise evidence, never silent truncation.
import type {
  CheckpointResult,
  CheckpointStamp,
  DeviceScanSummary,
  JournalIntegrityReport,
  SegmentSuspect,
} from '@/application/ports/journal.port.js';
import type { StorageEnginePort, StoreHandle } from '@/application/ports/storage-engine.port.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { verifySegmentCrc } from './segment.js';
import {
  JOURNAL_FORMAT_V,
  META_CHECKPOINT_KEY,
  META_JOURNAL_HEADS_KEY,
  type DeviceStreamHead,
  type JournalEntryRecord,
  type JournalSegmentRecord,
} from './types.js';

/** meta row wrapper: §5 meta is key → value. */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

/** Checkpoint pointer table as stored under META_CHECKPOINT_KEY (EES §5). */
type CheckpointTable = Readonly<Record<string, CheckpointStamp>>;

export interface ChainParams {
  readonly deviceId: DeviceId;
  /** All segments of this device stream (any order; verification owns the sort). */
  readonly segments: readonly JournalSegmentRecord[];
  readonly head: DeviceStreamHead | undefined;
  /**
   * First seq this walk is responsible for: 1 = full walk; ptr.throughSeq+1 = tail walk
   * (WAL design — bytes at/below the checkpoint are out of the cheap path's window).
   */
  readonly fromSeq: number;
}

/**
 * Verify one device stream's CRC/chain/seal/head/lamport laws. Total and pure: every
 * violation arrives as a suspect row; nothing throws.
 */
export function verifyDeviceChain(params: ChainParams): {
  suspects: SegmentSuspect[];
  summary: DeviceScanSummary;
} {
  const { deviceId, segments, head, fromSeq } = params;
  const suspects: SegmentSuspect[] = [];
  const sorted = [...segments].sort((a, b) => a.seqStart - b.seqStart);
  const entryCount = sorted.reduce((n, s) => n + s.entries.length, 0);

  const push = (suspect: SegmentSuspect): void => {
    suspects.push(suspect);
  };

  // Head-anchor law: a stream with segments MUST have a head (append commits them in
  // the same txn — one without the other is forked truth). Suspect, not infer.
  if (head === undefined && sorted.length > 0) {
    for (const s of sorted) push({ segmentId: s.segmentId, reason: 'head-drift' });
    return {
      suspects,
      summary: { deviceId, segments: sorted.length, entries: entryCount, durableThrough: 0 },
    };
  }
  const durableThrough = head?.lastSeq ?? 0;

  // CRC + per-segment law walk. Only segments that carry window bytes (tailSeq >=
  // fromSeq) pay verification in tail coverage — sealed pre-checkpoint bytes are the
  // full walk's jurisdiction.
  const tailSeqOf = (s: JournalSegmentRecord): number | undefined => s.entries.at(-1)?.seq;
  const inWindow = (s: JournalSegmentRecord): boolean => {
    const tail = tailSeqOf(s);
    return tail !== undefined && tail >= fromSeq;
  };

  for (const segment of sorted) {
    if (segment.formatV !== JOURNAL_FORMAT_V) {
      push({ segmentId: segment.segmentId, reason: 'format-unknown' });
      continue; // foreign format entitles no further interpretation
    }
    if (segment.entries.length === 0) {
      push({ segmentId: segment.segmentId, reason: 'entry-gap' });
    }
    if (!inWindow(segment)) continue;
    const verdict = verifySegmentCrc(segment);
    if (!verdict.ok) {
      push({
        segmentId: segment.segmentId,
        reason: 'crc-mismatch',
        expectedCrc: verdict.expected,
        actualCrc: verdict.actual,
      });
      // With the bytes provably drifted, deeper structural readings are meaningless for
      // this segment — further chain laws still apply to its NEIGHBOURS below.
      continue;
    }
  }

  // Chain law over the window: entries flatten in segment order and must present a
  // contiguous seq run starting exactly at fromSeq (or at 1 for full walks of streams
  // whose first segment IS the origin — compaction baselines arrive with E2-T11).
  if (head !== undefined) {
    const flat: JournalEntryRecord[] = [];
    for (const segment of sorted) {
      for (const entry of segment.entries) {
        if (entry.seq >= fromSeq) flat.push(entry);
      }
    }
    if (flat.length > 0) {
      const first = flat.at(0);
      if (first !== undefined && first.seq !== fromSeq) {
        push({
          segmentId: sorted.at(0)?.segmentId ?? `${deviceId}:?`,
          reason: 'chain-sequence',
          expectedCrc: undefined,
          actualCrc: undefined,
        });
      }
      let prevSeq: number | undefined;
      let prevBatch = -1;
      let prevLamport: number | undefined;
      const ownerSegment = sorted.at(0)?.segmentId ?? `${deviceId}:?`;
      for (const entry of flat) {
        if (prevSeq !== undefined && entry.seq !== prevSeq + 1) {
          push({ segmentId: ownerSegment, reason: 'chain-sequence' });
        }
        if (entry.batchIndex <= prevBatch && entry.seq === prevSeq) {
          // batchIndex must climb within equal-seq (torn dup territory)
          push({ segmentId: ownerSegment, reason: 'entry-gap' });
        }
        if (entry.event.hlc.deviceId !== deviceId) {
          push({ segmentId: ownerSegment, reason: 'boundary-drift' });
        }
        if (prevLamport !== undefined && entry.event.hlc.lamport < prevLamport) {
          // EES §2.2: lamport never decreases within a device journal.
          push({ segmentId: ownerSegment, reason: 'lamport-regression' });
        }
        prevSeq = entry.seq;
        prevBatch = entry.batchIndex;
        prevLamport = entry.event.hlc.lamport;
      }
      // Segment-boundary continuity: each fully-sealed segment must hand off exactly.
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted.at(i - 1);
        const cur = sorted.at(i);
        if (prev === undefined || cur === undefined) continue;
        const prevTail = prev.entries.at(-1);
        if (prevTail !== undefined && cur.entries.length > 0) {
          const curFirst = cur.entries.at(0);
          if (curFirst !== undefined && curFirst.seq !== prevTail.seq + 1) {
            push({ segmentId: cur.segmentId, reason: 'chain-sequence' });
          }
        }
      }
    }
    if (flat.length === 0 && head.lastSeq >= fromSeq) {
      // Window promised entries the bytes don't carry.
      push({
        segmentId: sorted.at(-1)?.segmentId ?? `${deviceId}:?`,
        reason: 'chain-sequence',
      });
    }

    // Seal law (§2.8 invariant): at most the FINAL segment is open, and the head anchor
    // must name exactly it (or null when everything is sealed).
    const last = sorted.at(-1);
    for (const segment of sorted) {
      if (!segment.sealed && segment !== last) {
        push({ segmentId: segment.segmentId, reason: 'seal-law' });
      }
    }
    if (last !== undefined) {
      if (last.sealed && head.openSegmentId !== null) {
        push({ segmentId: last.segmentId, reason: 'head-drift' });
      }
      if (!last.sealed && head.openSegmentId !== last.segmentId) {
        push({ segmentId: last.segmentId, reason: 'head-drift' });
      }
      const tailSeq = last.entries.at(-1)?.seq;
      if (tailSeq !== undefined && tailSeq !== head.lastSeq) {
        push({ segmentId: last.segmentId, reason: 'head-drift' });
      }
    }
  }

  return {
    suspects,
    summary: { deviceId, segments: sorted.length, entries: entryCount, durableThrough },
  };
}

const deviceIdsOf = (segments: readonly JournalSegmentRecord[]): string[] =>
  [...new Set(segments.map((s) => s.deviceId as string))].sort();

/** Full event-scan run under an open txn scope (shared by both scans + checkpoint). */
const collectDevices = async (
  events: StoreHandle<JournalSegmentRecord>,
  meta: StoreHandle<MetaRow>,
): Promise<{
  allSegments: readonly JournalSegmentRecord[];
  heads: Record<string, DeviceStreamHead>;
  allDevices: string[];
}> => {
  const allSegments = await events.toArray();
  const headsRow = await meta.get(META_JOURNAL_HEADS_KEY);
  const heads = (headsRow?.value ?? {}) as Record<string, DeviceStreamHead>;
  const deviceSet = new Set<string>([...Object.keys(heads), ...deviceIdsOf(allSegments)]);
  return { allSegments, heads, allDevices: [...deviceSet].sort() };
};

const runScan = (
  allSegments: readonly JournalSegmentRecord[],
  heads: Record<string, DeviceStreamHead>,
  allDevices: string[],
  fromSeqForDevice: (deviceId: string) => number,
  coverage: JournalIntegrityReport['coverage'],
): JournalIntegrityReport => {
  const suspects: SegmentSuspect[] = [];
  const devices: DeviceScanSummary[] = [];
  for (const deviceId of allDevices) {
    const owned = allSegments.filter((s) => (s.deviceId as string) === deviceId);
    const head = heads[deviceId];
    const run = verifyDeviceChain({
      deviceId: deviceId as DeviceId,
      segments: owned,
      head,
      fromSeq: fromSeqForDevice(deviceId),
    });
    suspects.push(...run.suspects);
    devices.push(run.summary);
  }
  return {
    status: suspects.length === 0 ? 'ok' : 'suspect',
    coverage,
    suspects,
    devices,
  };
};

export function createJournalScanner(engine: StorageEnginePort): {
  scanTail: () => Promise<Result<JournalIntegrityReport, LedgeError>>;
  scanFull: () => Promise<Result<JournalIntegrityReport, LedgeError>>;
  checkpoint: () => Promise<Result<CheckpointResult, LedgeError>>;
} {
  return {
    scanTail: () =>
      engine.txn(['events', 'meta'], 'readonly', async (tx) => {
        const events = tx.table<JournalSegmentRecord>('events');
        const meta = tx.table<MetaRow>('meta');
        const { allSegments, heads, allDevices } = await collectDevices(events, meta);
        const ptrRow = await meta.get(META_CHECKPOINT_KEY);
        const ptrs = (ptrRow?.value ?? {}) as CheckpointTable;
        return runScan(
          allSegments,
          heads,
          allDevices,
          (deviceId) => (ptrs[deviceId]?.throughSeq ?? 0) + 1,
          'tail',
        );
      }),

    scanFull: () =>
      engine.txn(['events', 'meta'], 'readonly', async (tx) => {
        const events = tx.table<JournalSegmentRecord>('events');
        const meta = tx.table<MetaRow>('meta');
        const { allSegments, heads, allDevices } = await collectDevices(events, meta);
        // Full walk: every byte is in window.
        return runScan(allSegments, heads, allDevices, () => 1, 'full');
      }),

    checkpoint: () =>
      engine.txn(['events', 'meta'], 'readwrite', async (tx) => {
        const events = tx.table<JournalSegmentRecord>('events');
        const meta = tx.table<MetaRow>('meta');
        const { allSegments, heads, allDevices } = await collectDevices(events, meta);
        const report = runScan(allSegments, heads, allDevices, () => 1, 'full');
        // §2.8 invariant: a checkpoint over suspect bytes would lie about restorability.
        if (report.status === 'suspect') {
          const first = report.suspects.at(0);
          throw ledgeError('E_JOURNAL_INTEGRITY', {
            raw: 'checkpoint-over-suspect',
            segmentId: first?.segmentId ?? 'unknown',
            suspects: report.suspects.length,
          });
        }
        const ptrRow = await meta.get(META_CHECKPOINT_KEY);
        const ptrs: Record<string, CheckpointStamp> = {
          ...((ptrRow?.value ?? {}) as CheckpointTable),
        };
        const stamped: CheckpointStamp[] = [];
        for (const deviceId of allDevices) {
          const owned = allSegments
            .filter((s) => (s.deviceId as string) === deviceId)
            .sort((a, b) => a.seqStart - b.seqStart);
          const last = owned.at(-1);
          const head = heads[deviceId];
          if (last === undefined || head === undefined) continue;
          const stamp: CheckpointStamp = {
            deviceId: deviceId as DeviceId,
            throughSeq: head.lastSeq,
            lastSegmentId: last.segmentId,
            crc: last.crc,
          };
          ptrs[deviceId] = stamp;
          stamped.push(stamp);
        }
        await meta.put({ key: META_CHECKPOINT_KEY, value: ptrs });
        return { stamped };
      }),
  };
}
