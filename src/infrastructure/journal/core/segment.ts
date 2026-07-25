// E1-T10 · segment transforms — pure functions over journal shapes (no IO, no clocks).
// Everything the appender computes about segmentation is decided here so the DB
// orchestration carries no decisions and these laws are golden-testable in isolation.
// E2-T01 · CRC-32 lifecycle: the checksum covers the canonical image of every record
// field (crcImageOf is THE projection — see its tripwire note), recomputed on each
// open-segment mutation and frozen at seal (ADR-004: sealed segments immutable).
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { CURRENT_SCHEMA_VERSION } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import { crc32Hex, stableStringify } from '@/shared-kernel/canon/index.js';
import {
  JOURNAL_FORMAT_V,
  SEGMENT_ENTRY_CAP,
  type JournalEntryRecord,
  type JournalSegmentRecord,
} from './types.js';

export const segmentIdFor = (deviceId: DeviceId, seqStart: number): string =>
  `${deviceId}:${seqStart}`;

/**
 * Canonical projection covered by the CRC. Field list is EXPLICIT (not rest-spread) so
 * a future format growth that forgets the image trips a test instead of silently
 * shipping un-checksummed bytes: journal.integrity.test.ts census-pins this list.
 */
const CRC_IMAGE_FIELDS = [
  'segmentId',
  'deviceId',
  'seqStart',
  'sealed',
  'formatV',
  'entries',
] as const;

type SegmentContent = Omit<JournalSegmentRecord, 'crc'>;

const crcImageOf = (segment: SegmentContent): string =>
  stableStringify({
    segmentId: segment.segmentId,
    deviceId: segment.deviceId,
    seqStart: segment.seqStart,
    sealed: segment.sealed,
    formatV: segment.formatV,
    entries: segment.entries,
  });

/** Recompute the checksum for a segment whose content fields just changed. */
export const withFreshCrc = (segment: SegmentContent): JournalSegmentRecord => ({
  ...segment,
  crc: crc32Hex(crcImageOf(segment)),
});

export type CrcVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly expected: string; readonly actual: string };

/** Re-derive the CRC of a stored record and compare against the stamped one. */
export const verifySegmentCrc = (segment: JournalSegmentRecord): CrcVerdict => {
  const actual = crc32Hex(crcImageOf(segment));
  return actual === segment.crc ? { ok: true } : { ok: false, expected: segment.crc, actual };
};

/**
 * Field census used by the census tripwire test: every record field EXCEPT crc must
 * appear in the CRC image. Drift here means new un-checksummed bytes — a format bug.
 */
export const crcCoveredFields = (): readonly string[] => CRC_IMAGE_FIELDS;

export const newSegment = (deviceId: DeviceId, seqStart: number): JournalSegmentRecord =>
  withFreshCrc({
    segmentId: segmentIdFor(deviceId, seqStart),
    deviceId,
    seqStart,
    sealed: false,
    formatV: JOURNAL_FORMAT_V,
    entries: [],
  });

/** A whole batch must fit one segment (batch-atomic packing); oversized is a caller bug. */
export const batchFits = (batchSize: number): boolean => batchSize <= SEGMENT_ENTRY_CAP;

/** Would appending this batch overflow the open segment (→ seal + roll over first)? */
export const needsRollover = (open: JournalSegmentRecord, batchSize: number): boolean =>
  open.entries.length + batchSize > SEGMENT_ENTRY_CAP;

/** Pack one batch into a fresh/open segment, returning the next segment value.
 *  Appender-validated invariants (homogeneous device, contiguous seq) are preconditions. */
export const withBatchAppended = (
  segment: JournalSegmentRecord,
  batch: readonly EventEnvelope[],
): JournalSegmentRecord =>
  withFreshCrc({
    ...segment,
    entries: [
      ...segment.entries,
      ...batch.map((event, batchIndex): JournalEntryRecord => ({
        seq: event.hlc.seq,
        batchIndex,
        v: CURRENT_SCHEMA_VERSION,
        event,
      })),
    ],
  });

export const seal = (segment: JournalSegmentRecord): JournalSegmentRecord =>
  withFreshCrc({ ...segment, sealed: true });
