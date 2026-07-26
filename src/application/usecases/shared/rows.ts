// E3-APP · Read-side row access for services — index-covered reads ONLY (EES §2.9
// no-scan-path law: every read here is pk-get or declared-index range). Forward
// tolerance (§2.9): missing/extra fields degrade, never throw.
import type { StorageEnginePort, StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

export const readMission = async (
  engine: StorageEnginePort,
  missionId: string,
): Promise<Result<StoredRecord | undefined, LedgeError>> =>
  engine.txn(['missions'], 'readonly', async (tx) =>
    tx.table<StoredRecord>('missions').get(missionId),
  );

export const missionStateOf = (row: StoredRecord | undefined): string => {
  const s = row?.['state'];
  return typeof s === 'string' ? s : 'live';
};

export const missionNameOf = (row: StoredRecord | undefined): string => {
  const n = row?.['name'];
  return typeof n === 'string' ? n : '';
};

export const missionTabIdsOf = (row: StoredRecord | undefined): readonly string[] => {
  const t = row?.['tabIds'];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
};

export const readTab = async (
  engine: StorageEnginePort,
  ledgeTabId: string,
): Promise<Result<StoredRecord | undefined, LedgeError>> =>
  engine.txn(['tabs'], 'readonly', async (tx) => tx.table<StoredRecord>('tabs').get(ledgeTabId));

export const tabStateOf = (row: StoredRecord | undefined): string => {
  const s = row?.['state'];
  return typeof s === 'string' ? s : 'live';
};

export const tabMissionOf = (row: StoredRecord | undefined): string => {
  const m = row?.['missionId'];
  return typeof m === 'string' ? m : '';
};

/** missionId-index read (schema v1: tabs.missionId). */
export const readTabsByMission = async (
  engine: StorageEnginePort,
  missionId: string,
): Promise<Result<readonly StoredRecord[], LedgeError>> =>
  engine.txn(['tabs'], 'readonly', async (tx) =>
    tx.table<StoredRecord>('tabs').byIndex({ kind: 'equals', name: 'missionId', value: missionId }),
  );

/** Settings rows for the policy reader (domain lifecycle policyOf). */
export const readSettingsRows = async (
  engine: StorageEnginePort,
): Promise<Result<readonly StoredRecord[], LedgeError>> =>
  engine.txn(['settings'], 'readonly', async (tx) => tx.table<StoredRecord>('settings').toArray());

/** Trash rows by deletedAt index? v1 sweep reads use state indexes; trash readers use
 *  the [state+lastActiveAt]/deletedAt family. This one is the trash-set read for
 *  EmptyTrash/GetTrash: tabs TRASH via state index + missions TRASH via state index. */
export const readTrashedTabs = async (
  engine: StorageEnginePort,
): Promise<Result<readonly StoredRecord[], LedgeError>> =>
  engine.txn(['tabs'], 'readonly', async (tx) =>
    tx.table<StoredRecord>('tabs').byIndex({ kind: 'equals', name: 'state', value: 'trash' }),
  );

export const readTrashedMissions = async (
  engine: StorageEnginePort,
): Promise<Result<readonly StoredRecord[], LedgeError>> =>
  engine.txn(['missions'], 'readonly', async (tx) =>
    tx.table<StoredRecord>('missions').byIndex({ kind: 'equals', name: 'state', value: 'trash' }),
  );

/** Live-tab inventory (open set). toArray is a covered primary walk (StoreHandle law);
 *  the live set is browser-bounded. Park-scoping reads its browserTabId/windowId/
 *  groupId coordinates — v1 has no secondary index on them (schema v1 frozen). */
export const readLiveTabs = async (
  engine: StorageEnginePort,
): Promise<Result<readonly StoredRecord[], LedgeError>> =>
  engine.txn(['tabs'], 'readonly', async (tx) =>
    tx.table<StoredRecord>('tabs').byIndex({ kind: 'equals', name: 'state', value: 'live' }),
  );

/** One meta row value (rate stamps, purges, booking keys). */
export const readMeta = async (
  engine: StorageEnginePort,
  key: string,
): Promise<Result<unknown, LedgeError>> =>
  engine.txn(['meta'], 'readonly', async (tx) => {
    const row = await tx.table<StoredRecord>('meta').get(key);
    return row === undefined ? undefined : row['value'];
  });

/** Re-exported row types for service signatures (never re-declared here). */
export type { MissionViewRow, TabStoreRow };
