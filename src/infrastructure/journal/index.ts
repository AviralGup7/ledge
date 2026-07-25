// Public surface of infrastructure/journal (Blueprint §2.6, EES §2.8).
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { createJournalAppender } from './core/appender.js';
import { createJournalScanner } from './core/scanner.js';

export { createJournalAppender } from './core/appender.js';
export { SEGMENT_ENTRY_CAP, JOURNAL_FORMAT_V, META_JOURNAL_HEADS_KEY } from './core/types.js';
export type { JournalEntryRecord, JournalSegmentRecord } from './core/types.js';

/**
 * The full JournalPort (E2-T01): append/readRange + scanTail/scanFull/checkpoint.
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
  };
}
