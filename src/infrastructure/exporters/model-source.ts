// E5-T03 · Engine-backed ExportModelSource — the read-model feed for buildModel.
// Depcruise law "importers-exporters-via-application-only": this family touches
// storage ONLY through the application port (StorageEnginePort) and the §5 row
// declarations (view-rows) — never through infrastructure/(journal|storage).
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { MissionViewRow, TabStoreRow } from '@/application/ports/view-rows.js';
import type { ExportModelSource } from './model.js';

/** Read the full missions/tabs read-model shelves (the projection snapshot's
 *  raw material — ADR-045). Reads are read-only txns; engine errors pass through
 *  verbatim (fail-loud — the export cannot silently under-read truth). */
export const createEngineModelSource = (engine: StorageEnginePort): ExportModelSource => ({
  missions: () =>
    engine.txn(['missions'], 'readonly', (tx) =>
      tx
        .table<MissionViewRow>('missions')
        .toArray()
        .then((rows) => rows.filter((m) => typeof m.missionId === 'string')),
    ),
  tabs: () =>
    engine.txn(['tabs'], 'readonly', (tx) =>
      tx
        .table<TabStoreRow>('tabs')
        .toArray()
        .then((rows) => rows.filter((t) => typeof t.ledgeTabId === 'string')),
    ),
});
