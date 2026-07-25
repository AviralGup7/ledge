// E7-T02 · Storage scenarios — raw IDB transaction latency on the Dexie reference
// backend (mission metric). Round-trip a single meta write per sample; the number
// is the floor every durable write family stands on.
import type { PerfConfig } from '../config.js';
import type { BackendSession } from '../backends.js';
import { latencyRow, must } from './shared.js';
import { nowMs } from '../timing.js';
import type { ScenarioResult } from '../types.js';

export const FAMILY = 'storage';

export const storageScenarios = async (
  session: BackendSession,
  scale: number,
  cfg: PerfConfig,
): Promise<readonly ScenarioResult[]> => {
  const backend = await session.open();
  const ms: number[] = [];
  for (let i = 0; i < cfg.samples + cfg.warmup; i += 1) {
    const t0 = nowMs();
    must(
      await backend.engine.txn(['meta'], 'readwrite', async (tx) => {
        await tx.table('meta').put({ key: `perf-txn-probe`, value: i });
        return undefined;
      }),
      'idb.txn',
    );
    if (i >= cfg.warmup) ms.push(nowMs() - t0);
  }
  return [latencyRow(session.name, FAMILY, 'idb.txn', scale, ms)];
};
