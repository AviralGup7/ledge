// E3-APP · Use-case handlers — the closed-world parity table (EES §2.6/§3). Every v1
// wire command/query name maps to exactly ONE handler over the public services; the
// parity test proves both directions (contracts ⇄ registry). Lane law (§2.6):
// interactive default; maintenance for heavy/sweeps. neverAutoRetry law (§3.3 notes):
// C11 (confirm-gated), C15/C17/C25 (irreversible/confirm), C18 (ambiguity §10-R9).
// Payload reads are typed-extraction total functions — validators already enforced
// shapes (§3.1), services re-decide legality (§2.5).
import {
  commandOf,
  queryOf,
  type CommandRegistration,
  type QueryRegistration,
} from '../hub/dispatch/registry.js';
import type { AppServices } from './index.js';
import type { HandlerCtx } from '../hub/dispatch/types.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError } from '@/shared-kernel/result/index.js';

type S = AppServices;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strArr = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Payload extraction backstop (validators ran first; this is the typed seam). */
const missing = (name: string, field: string): Promise<Result<never, LedgeError>> =>
  Promise.resolve(
    err(ledgeError('E_OUTPUT_MALFORMED', { what: `payload-${String(name)}.${field}` })),
  );

const useCtx = (ctx: HandlerCtx<S>) => ({
  cid: ctx.message.cid,
  token: ctx.token,
  progress: ctx.progress,
  notifyPending: ctx.notifyPending,
});

export const WIRE_COMMANDS: readonly CommandRegistration<S>[] = [
  commandOf('FirstRunIngest', (ctx) => ctx.services.system.firstRunIngest(useCtx(ctx))),
  commandOf('StartMission', (ctx) =>
    ctx.services.missions.start({ name: str(ctx.message.payload['name']) }, useCtx(ctx)),
  ),
  commandOf('ParkTab', (ctx) => {
    const browserTabId = num(ctx.message.payload['browserTabId']);
    if (browserTabId === undefined) return missing('ParkTab', 'browserTabId');
    return ctx.services.park.parkTab({ browserTabId }, useCtx(ctx));
  }),
  commandOf('ParkGroup', (ctx) => {
    const groupId = num(ctx.message.payload['groupId']);
    if (groupId === undefined) return missing('ParkGroup', 'groupId');
    return ctx.services.park.parkGroup({ groupId }, useCtx(ctx));
  }),
  commandOf('ParkWindow', (ctx) => {
    const windowId = num(ctx.message.payload['windowId']);
    if (windowId === undefined) return missing('ParkWindow', 'windowId');
    return ctx.services.park.parkWindow({ windowId }, useCtx(ctx));
  }),
  commandOf('ParkAll', (ctx) =>
    ctx.services.park.parkAll(
      { exceptWindowId: num(ctx.message.payload['exceptWindowId']) },
      useCtx(ctx),
    ),
  ),
  commandOf('ResumeMission', (ctx) => {
    const missionId = str(ctx.message.payload['missionId']);
    const mode = str(ctx.message.payload['mode']);
    if (missionId === undefined || (mode !== 'full' && mode !== 'partial'))
      return missing('ResumeMission', 'missionId/mode');
    const rawTabIds = ctx.message.payload['tabIds'];
    return ctx.services.resume.resumeMission(
      {
        missionId,
        mode,
        ...(rawTabIds !== undefined ? { tabIds: strArr(rawTabIds) } : {}),
      },
      useCtx(ctx),
    );
  }),
  commandOf('RestoreRecentlyClosed', (ctx) => {
    const ids = strArr(ctx.message.payload['ids']);
    const target = str(ctx.message.payload['target']);
    if (target === undefined) return missing('RestoreRecentlyClosed', 'target');
    return ctx.services.resume.restoreRecentlyClosed({ ids, target }, useCtx(ctx));
  }),
  commandOf('RenameMission', (ctx) => {
    const missionId = str(ctx.message.payload['missionId']);
    const name = str(ctx.message.payload['name']);
    if (missionId === undefined || name === undefined)
      return missing('RenameMission', 'missionId/name');
    return ctx.services.missions.rename({ missionId, name }, useCtx(ctx));
  }),
  commandOf('MoveTabs', (ctx) => {
    const tabIds = strArr(ctx.message.payload['tabIds']);
    const toMissionId = str(ctx.message.payload['toMissionId']);
    if (toMissionId === undefined) return missing('MoveTabs', 'toMissionId');
    return ctx.services.missions.moveTabs({ tabIds, toMissionId }, useCtx(ctx));
  }),
  commandOf(
    'MergeMissions',
    (ctx) => {
      const fromId = str(ctx.message.payload['fromId']);
      const intoId = str(ctx.message.payload['intoId']);
      if (fromId === undefined || intoId === undefined)
        return missing('MergeMissions', 'fromId/intoId');
      return ctx.services.missions.merge({ fromId, intoId }, useCtx(ctx));
    },
    { neverAutoRetry: true }, // C11 confirm-gated
  ),
  commandOf('SplitMission', (ctx) => {
    const tabIds = strArr(ctx.message.payload['tabIds']);
    const newName = str(ctx.message.payload['newName']);
    return ctx.services.missions.split(
      { tabIds, ...(newName !== undefined ? { newName } : {}) },
      useCtx(ctx),
    );
  }),
  commandOf('ArchiveMission', (ctx) => {
    const missionId = str(ctx.message.payload['missionId']);
    if (missionId === undefined) return missing('ArchiveMission', 'missionId');
    return ctx.services.missions.archive({ missionId }, useCtx(ctx));
  }),
  commandOf('ConcludeMission', (ctx) => {
    const missionId = str(ctx.message.payload['missionId']);
    if (missionId === undefined) return missing('ConcludeMission', 'missionId');
    return ctx.services.missions.conclude(
      { missionId, outcomeNote: str(ctx.message.payload['outcomeNote']) },
      useCtx(ctx),
    );
  }),
  commandOf(
    'DeleteEntity',
    (ctx) => {
      const kind = str(ctx.message.payload['kind']);
      const id = str(ctx.message.payload['id']);
      if ((kind !== 'tab' && kind !== 'mission') || id === undefined)
        return missing('DeleteEntity', 'kind/id');
      return ctx.services.trash.deleteEntity(
        {
          kind,
          id,
          bulkSize: num(ctx.message.payload['bulkSize']),
          confirmedLarge: bool(ctx.message.payload['confirmedLarge']),
        },
        useCtx(ctx),
      );
    },
    { neverAutoRetry: true }, // C15 irreversible-class
  ),
  commandOf('RestoreFromTrash', (ctx) => {
    const kind = str(ctx.message.payload['kind']);
    const id = str(ctx.message.payload['id']);
    if ((kind !== 'tab' && kind !== 'mission') || id === undefined)
      return missing('RestoreFromTrash', 'kind/id');
    return ctx.services.trash.restore({ kind, id }, useCtx(ctx));
  }),
  commandOf(
    'EmptyTrash',
    (ctx) =>
      ctx.services.trash.emptyTrash(
        { confirm: ctx.message.payload['confirm'] === true },
        useCtx(ctx),
      ),
    { neverAutoRetry: true }, // C17 irreversible
  ),
  commandOf(
    'Undo',
    (ctx) => ctx.services.undo.undo(useCtx(ctx)),
    { neverAutoRetry: true }, // C18 + §10-R9 ambiguity law
  ),
  commandOf('SetSetting', (ctx) => {
    const key = str(ctx.message.payload['key']);
    if (key === undefined) return missing('SetSetting', 'key');
    return ctx.services.system.setSetting(
      { key, value: ctx.message.payload['value'] },
      useCtx(ctx),
    );
  }),
  commandOf('ImportPreviewRequest', (ctx) => {
    const fileMeta = ctx.message.payload['fileMeta'];
    const meta =
      typeof fileMeta === 'object' && fileMeta !== null
        ? (fileMeta as Record<string, unknown>)
        : {};
    return ctx.services.portability.importPreview(
      {
        fileMeta: { name: str(meta['name']) ?? '', size: num(meta['size']) ?? 0 },
        parserHint: str(ctx.message.payload['parserHint']),
      },
      useCtx(ctx),
    );
  }),
  commandOf('ImportCommit', (ctx) => {
    const previewId = str(ctx.message.payload['previewId']);
    const dedupeMode = str(ctx.message.payload['dedupeMode']);
    if (previewId === undefined || (dedupeMode !== 'skip' && dedupeMode !== 'import-anyway'))
      return missing('ImportCommit', 'previewId/dedupeMode');
    return ctx.services.portability.importCommit({ previewId, dedupeMode }, useCtx(ctx));
  }),
  commandOf('ExportRequest', (ctx) => {
    const scope = ctx.message.payload['scope'];
    const formats = strArr(ctx.message.payload['formats']).filter(
      (f): f is 'json' | 'html' | 'md' => f === 'json' || f === 'html' || f === 'md',
    );
    const missionId = typeof scope === 'string' ? scope : undefined;
    return ctx.services.portability.exportRequest(
      {
        scope:
          scope === 'all' || scope === undefined
            ? { kind: 'all' }
            : { kind: 'mission', missionId: missionId ?? '' },
        formats,
      },
      useCtx(ctx),
    );
  }),
  commandOf('RepairRebuild', (ctx) => {
    const scope = ctx.message.payload['scope'];
    return ctx.services.system.repairRebuild(
      { scope: scope === 'all' ? 'all' : (str(scope) ?? 'all') },
      useCtx(ctx),
    );
  }),
  commandOf(
    'RescueScanNow',
    (ctx) => {
      const mode = str(ctx.message.payload['mode']);
      if (mode !== 'tail' && mode !== 'full') return missing('RescueScanNow', 'mode');
      return ctx.services.system.rescueScanNow({ mode }, useCtx(ctx));
    },
    { lane: 'maintenance' },
  ),
  commandOf(
    'ForgetEverything',
    (ctx) =>
      ctx.services.system.forgetEverything(
        { confirm: ctx.message.payload['confirm'] === true },
        useCtx(ctx),
      ),
    { neverAutoRetry: true }, // C25 irreversible
  ),
  commandOf('ExportDiagnostics', (ctx) =>
    ctx.services.system.exportDiagnostics(
      { includeAddresses: bool(ctx.message.payload['includeAddresses']) },
      useCtx(ctx),
    ),
  ),
];

export const WIRE_QUERIES: readonly QueryRegistration<S>[] = [
  queryOf('GetBootstrap', (ctx) =>
    ctx.services.queries.getBootstrap({ surface: str(ctx.message.payload['surface']) ?? 'quiet' }),
  ),
  queryOf('GetLibrary', (ctx) =>
    ctx.services.queries.getLibrary({
      filter: ctx.message.payload['filter'],
      sort: str(ctx.message.payload['sort']),
      cursor: str(ctx.message.payload['cursor']),
    }),
  ),
  queryOf('GetMissionDetail', (ctx) => {
    const missionId = str(ctx.message.payload['missionId']);
    if (missionId === undefined) return missing('GetMissionDetail', 'missionId');
    return ctx.services.queries.getMissionDetail({ missionId });
  }),
  queryOf('GetRecentlyClosed', (ctx) =>
    ctx.services.queries.getRecentlyClosed({ cursor: str(ctx.message.payload['cursor']) }),
  ),
  queryOf('GetTrash', (ctx) => ctx.services.queries.getTrash()),
  queryOf('SearchQuery', (ctx) => {
    const q = str(ctx.message.payload['q']);
    if (q === undefined) return missing('SearchQuery', 'q');
    return ctx.services.queries.search({
      q,
      scope: str(ctx.message.payload['scope']),
      limit: num(ctx.message.payload['limit']),
    });
  }),
  queryOf('GetHealth', (ctx) => ctx.services.queries.getHealth()),
  queryOf('PeekOpenTabs', (ctx) =>
    ctx.services.queries.peekOpenTabs({ windowId: num(ctx.message.payload['windowId']) }),
  ),
];

// ── Internal Tier-2 command catalog (frozen wire world is append-only — these never
//    ride §3 wire names; in-process dispatchers serve them per the internal parity
//    law in handlers.parity.test.ts). Mission inventory: Open/Close Tabs, Redo,
//    Tag (Topics correction), Favorite, Pin, Recent Activity/History. ────────────────
export const INTERNAL_COMMANDS: readonly CommandRegistration<S>[] = [
  commandOf('OpenTabs', (ctx) =>
    ctx.services.tabs.openTabs(
      {
        urls: strArr(ctx.message.payload['urls']),
        windowId: num(ctx.message.payload['windowId']),
      },
      useCtx(ctx),
    ),
  ),
  commandOf('CloseTabs', (ctx) =>
    ctx.services.tabs.closeTabs(
      { browserTabIds: strArr(ctx.message.payload['ids']).map(Number) },
      useCtx(ctx),
    ),
  ),
  commandOf('Redo', (ctx) => ctx.services.undo.redo(useCtx(ctx)), { neverAutoRetry: true }),
  commandOf('CorrectTopic', (ctx) => {
    const subjectId = str(ctx.message.payload['subjectId']);
    const value = str(ctx.message.payload['value']);
    if (subjectId === undefined || value === undefined)
      return missing('CorrectTopic', 'subjectId/value');
    return ctx.services.prefs.correctTopic(
      { subjectId, value, priorArtifactId: str(ctx.message.payload['priorArtifactId']) },
      useCtx(ctx),
    );
  }),
  commandOf('SetFavorite', (ctx) => {
    const entityKind = str(ctx.message.payload['entityKind']);
    const id = str(ctx.message.payload['id']);
    if ((entityKind !== 'mission' && entityKind !== 'tab') || id === undefined)
      return missing('SetFavorite', 'entityKind/id');
    return ctx.services.prefs.setFavorite(
      { entityKind, id, favor: ctx.message.payload['favor'] === true },
      useCtx(ctx),
    );
  }),
  commandOf('SetPinned', (ctx) => {
    const id = str(ctx.message.payload['id']);
    if (id === undefined) return missing('SetPinned', 'id');
    return ctx.services.prefs.setPinned(
      { id, pinned: ctx.message.payload['pinned'] === true },
      useCtx(ctx),
    );
  }),
];

export const INTERNAL_QUERIES: readonly QueryRegistration<S>[] = [
  queryOf('GetActivity', (ctx) =>
    ctx.services.queries.getActivity({ limit: num(ctx.message.payload['limit']) }),
  ),
  queryOf('GetHistory', (ctx) =>
    // History ≡ the closed/trash timeline read (Recent Activity's archive view).
    ctx.services.queries.getActivity({ limit: num(ctx.message.payload['limit']) }),
  ),
];
