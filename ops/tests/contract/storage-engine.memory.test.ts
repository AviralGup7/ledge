// E1-T12 · ADR-032 binding #2 — the identical contract suite against the in-memory
// adapter. Two independent implementations passing one law set is the suite's point.
import { createMemoryStorageEngine } from '@/infrastructure/storage/memory/memory-engine.js';
import { describeStorageEngineContract } from './storage-engine.contract.js';

describeStorageEngineContract('memory', () => createMemoryStorageEngine());
