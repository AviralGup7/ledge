// E3-APP · Tabs store projector — the §5 'tabs' row truth machine the use cases read.
// The projection registry grows with use cases (projections/index law); this projector
// makes per-tab state (LIVE|KEPT|TRASH), membership, and lifecycle stamps derivable.
// State-assignment LAW (R1 heartbeat semantics ride on it):
//   * TabObserved forms LIVE rows (browser truth, journal covered).
//   * KEPT stamps ONLY on TabAssigned — the park COMPLETION's per-tab placement (the
//     executor's completion batch is the sole producer; formation/first-run assign
//     membership via MissionFormed.tabIds WITHOUT touching state — R1: kept counts
//     are post-Applied facts, never ack-time optimism).
//   * TabMoved re-homes without changing state (C10 moves KEPT-or-LIVE tabs).
//   * TabClosedExternal removes LIVE rows only — KEPT/TRASH rows are stickier than
//     close observations (a park-initiated close racing ingest meets a KEPT row and
//     must not erase it; RecentlyClosed attribution is the R2 reconciler's domain).
//   * EntityTrashed stamps TRASH + deletedAt; TrashRestored re-homes to the resolved
//     mission as KEPT; TrashPurged removes the row (view purge mirrors journal law).
// Every rule is upsert-idempotent; everything derives from the journal.
import type { DeltaOp, ProjectorDef } from '@/application/ports/projection-engine.port.js';

/** §5 'tabs' row — declaration lives at the application port seam (view-rows). */
export type { TabStoreRow } from '@/application/ports/view-rows.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

const asIds = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export const tabsStoreProjector: ProjectorDef = {
  view: 'tabs',
  store: 'tabs',
  keyField: 'ledgeTabId',
  projectorV: 1,
  async project(event, read): Promise<readonly DeltaOp[]> {
    const p = event.payload as Record<string, unknown>;
    const wall = event.hlc.wallClock;
    switch (event.type) {
      case 'TabObserved': {
        const ledgeTabId = str(p['ledgeTabId']);
        if (ledgeTabId.length === 0) return [];
        return [
          {
            kind: 'upsert',
            key: ledgeTabId,
            record: {
              ledgeTabId,
              missionId: '',
              url: str(p['url']),
              title: str(p['title']),
              domain: str(p['domain']),
              state: 'live',
              firstSeenAt: numOr(p['ts'], wall),
              lastActiveAt: numOr(p['ts'], wall),
              // Never store explicit-undefined bytes (structured-clone discipline).
              ...(typeof p['browserTabId'] === 'number' ? { browserTabId: p['browserTabId'] } : {}),
            },
          },
        ];
      }
      case 'TabUpdated': {
        const ledgeTabId = str(p['ledgeTabId']);
        if (ledgeTabId.length === 0) return [];
        const changes = event.payload as Record<string, unknown>;
        const c = changes['changes'];
        const fields: Record<string, unknown> = { lastActiveAt: wall };
        if (typeof c === 'object' && c !== null) {
          const cr = c as Record<string, unknown>;
          if (typeof cr['url'] === 'string') fields['url'] = cr['url'];
          if (typeof cr['title'] === 'string') fields['title'] = cr['title'];
          if (typeof cr['domain'] === 'string') fields['domain'] = cr['domain'];
        }
        return [{ kind: 'patch', key: ledgeTabId, fields }];
      }
      case 'TabActivatedObserved': {
        const ledgeTabId = str(p['ledgeTabId']);
        if (ledgeTabId.length === 0) return [];
        return [{ kind: 'patch', key: ledgeTabId, fields: { lastActiveAt: numOr(p['ts'], wall) } }];
      }
      case 'TabClosedExternal': {
        const ledgeTabId = str(p['ledgeTabId']);
        if (ledgeTabId.length === 0) return [];
        // Finality guard: only LIVE rows die on a close observation. KEPT/TRASH rows
        // are journal-ahead facts (park completion already landed or the user binned
        // them) — the close stream must not paper over them (R2 race).
        const current = await read(ledgeTabId);
        const state = current === undefined ? 'live' : str(current['state']);
        if (state !== 'live') return [];
        return [{ kind: 'remove', key: ledgeTabId }];
      }
      case 'MissionFormed': {
        // Membership assignment from formation (first-run/split/R13-parent) —
        // state untouched (formation over LIVE tabs keeps them LIVE; §2.9 additive).
        const missionId = str(p['missionId']);
        if (missionId.length === 0) return [];
        return asIds(p['tabIds']).map((tabId) => ({
          kind: 'patch' as const,
          key: tabId,
          fields: { missionId, lastActiveAt: wall },
        }));
      }
      case 'TabAssigned': {
        // Park-completion placement: the ONE producer ⇒ KEPT stamp is unambiguous.
        const tabId = str(p['tabId']);
        const missionId = str(p['missionId']);
        if (tabId.length === 0 || missionId.length === 0) return [];
        return [
          {
            kind: 'patch',
            key: tabId,
            fields: { missionId, state: 'kept', lastActiveAt: wall },
          },
        ];
      }
      case 'TabMoved': {
        const tabId = str(p['tabId']);
        const missionId = str(p['missionId']);
        if (tabId.length === 0 || missionId.length === 0) return [];
        return [{ kind: 'patch', key: tabId, fields: { missionId, lastActiveAt: wall } }];
      }
      case 'EntityTrashed': {
        if (str(p['kind']) !== 'tab') return [];
        const id = str(p['id']);
        if (id.length === 0) return [];
        return [
          {
            kind: 'patch',
            key: id,
            fields: { state: 'trash', deletedAt: numOr(p['deletedAt'], wall), lastActiveAt: wall },
          },
        ];
      }
      case 'TrashRestored': {
        if (str(p['kind']) !== 'tab') return [];
        const id = str(p['id']);
        const resolved = str(p['resolvedMissionId']);
        if (id.length === 0) return [];
        return [
          {
            kind: 'patch',
            key: id,
            fields: {
              state: 'kept',
              ...(resolved.length > 0 ? { missionId: resolved } : {}),
              deletedAt: null,
              lastActiveAt: wall,
            },
          },
        ];
      }
      case 'TrashPurged': {
        if (str(p['kind']) !== 'tab') return [];
        const id = str(p['id']);
        if (id.length === 0) return [];
        return [{ kind: 'remove', key: id }];
      }
      default:
        return [];
    }
  },
};
