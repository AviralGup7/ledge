// Public surface of infrastructure/journal (Blueprint §2.6, EES §2.8).
import type { CompactionBaseline, JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { DeviceId } from '@/shared-kernel/identity/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { compactJournal } from './compact/index.js';
import { createJournalAppender } from './core/appender.js';
import { createJournalScanner } from './core/scanner.js';
import { META_PURGE_EPOCH_KEY } from './core/types.js';

export { createJournalAppender } from './core/appender.js';
export {
  SEGMENT_ENTRY_CAP,
  JOURNAL_FORMAT_V,
  META_JOURNAL_HEADS_KEY,
  META_PURGE_EPOCH_KEY,
} from './core/types.js';
export type { JournalEntryRecord, JournalSegmentRecord } from './core/types.js';
export {
  CHUNK_SEGMENTS_DEFAULT,
  EXCLUDED_SAMPLE_CAP,
  digestOfPlan,
  payloadMatchesId,
  windowSegments,
} from './compact/index.js';
export type {
  CompactionPlan,
  CompactionReport,
  ExcludedMatch,
  PurgeChainRef,
} from './compact/index.js';

/**
 * The full JournalPort (E2-T01): append/readRange + scanTail/scanFull/checkpoint.
 * E2-T11 completes it with compact/compactionState — the compactor reuses the
 * scanner's checkpoint so the restamp law keeps exactly one home (compact/types L7).
 * One engine, one port — the hub's durable-write plane of record.
 */
export function createJournal(engine: StorageEnginePort): JournalPort {
  const appender = createJournalAppender(engine);
  const scanner = createJournalScanner(engine);
  return {
    append: appender.append,
    appendHinged: appender.appendHinged,
    readRange: appender.readRange,
    scanTail: scanner.scanTail,
    scanFull: scanner.scanFull,
    checkpoint: scanner.checkpoint,
    compact: (plan) => compactJournal({ engine, checkpoint: scanner.checkpoint }, plan),
    compactionState: (deviceId: DeviceId): Promise<Result<CompactionBaseline | null, LedgeError>> =>
      engine.txn(['meta'], 'readonly', async (tx) => {
        const row = await tx
          .table<{ key: string; value: unknown }>('meta')
          .get(META_PURGE_EPOCH_KEY);
        const table = (row?.value ?? {}) as Record<string, CompactionBaseline>;
        return table[deviceId as string] ?? null;
      }),
  };
}
