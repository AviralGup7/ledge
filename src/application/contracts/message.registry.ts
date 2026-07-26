// E1-T11 · EES §3 message registry (data-only per P-08 / registry-purity) — the closed
// world of v1 message names. Every name a boundary validator may see, with direction,
// availability, payload contract, and terminal-response shape where §3 fixes one.
// Names are append-only across versions (ADR-010/033: `v` bump + dual-read window).
// Parse/validation notes in §3's "Validation highlights" that are advisory (collapse
// whitespace, surface-side confirms) are hub duties, not registry data.
//
// 'unknown' field specs are deliberate escape hatches where §3 leaves a shape to a later
// tier (views, manifests, opaque refs) — Tier-2 contracts narrow them additively.
import type { SchemaSpec } from './schema.js';

/** Wire enum, frozen by EES §3.1: command | query | event | stream. */
export type WireKind = 'command' | 'query' | 'event' | 'stream';
/** Section anchor inside §3 (workroom/sync rows ride wire kind 'event' — ADR-010's
 *  fire-and-forget control class; the frozen §3.1 enum stays closed). */
export type MessageFamily = 'command' | 'query' | 'stream' | 'workroom' | 'sync';
export type Availability = 'v1' | 'v1.1' | 'v2-boundary';

export interface MessageSpec {
  readonly kind: WireKind;
  readonly family: MessageFamily;
  readonly availability: Availability;
  readonly payload: SchemaSpec;
  readonly response?: SchemaSpec; // terminal Applied shape where §3 fixes fields
}

/** §3.2 uniform error envelope as a reusable payload spec (streams carrying failures). */
const ERROR_ENVELOPE_SPEC: SchemaSpec = {
  code: 'string',
  retryable: 'boolean',
  messageKey: 'string',
  recoveryKey: 'string',
  'details?': 'unknown',
  'watermarkHint?': 'number',
};

export const MESSAGE_REGISTRY: Readonly<Record<string, MessageSpec>> = {
  // ── §3.3 Commands (Surface → SW authority) ──────────────────────────────────────
  FirstRunIngest: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: {},
    response: { missionsCreated: 'int', tabsCaptured: 'int' },
  },
  StartMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { 'name?': { text: { maxLength: 120 } } },
    response: { missionId: 'id', windowId: 'int' },
  },
  ParkTab: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { browserTabId: 'int' },
    response: { kept: 'id' },
  },
  ParkGroup: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { groupId: 'int' },
    response: { missionId: 'id', keptCount: 'int' },
  },
  ParkWindow: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { windowId: 'int' },
    response: { missionId: 'id', keptCount: 'int', briefQueued: 'boolean' },
  },
  ParkAll: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { 'exceptWindowId?': 'int' },
    response: { missions: 'int', keptCount: 'int' },
  },
  ResumeMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: {
      missionId: 'id',
      mode: { enum: ['full', 'partial'] },
      'tabIds?': { array: 'id', maxItems: 10000 },
    },
    response: { windowId: 'int', restored: 'int', moved: 'int' },
  },
  RestoreRecentlyClosed: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { ids: { array: 'id' }, target: { oneOf: ['id', { enum: ['new'] }] } },
    response: { restored: 'int' },
  },
  RenameMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { missionId: 'id', name: { text: { maxLength: 120 } } },
    response: { 'oldName?': 'string' },
  },
  MoveTabs: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { tabIds: { array: 'id' }, toMissionId: 'id' },
    response: { moved: 'int' },
  },
  MergeMissions: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { fromId: 'id', intoId: 'id' },
    response: { intoId: 'id' },
  },
  SplitMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { tabIds: { array: 'id' }, 'newName?': { text: { maxLength: 120 } } },
    response: { newMissionId: 'id' },
  },
  ArchiveMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { missionId: 'id' },
    response: {},
  },
  ConcludeMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { missionId: 'id', 'outcomeNote?': { text: { maxLength: 2000 } } },
    response: {},
  },
  DeleteEntity: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: {
      kind: { enum: ['tab', 'mission'] },
      id: 'id',
      'bulkSize?': 'int',
      'confirmedLarge?': 'boolean',
    },
    response: { trashed: 'int' },
  },
  RestoreFromTrash: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { kind: { enum: ['tab', 'mission'] }, id: 'id' },
    response: { missionId: 'id' },
  },
  EmptyTrash: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { confirm: { literal: true } },
    response: { purged: 'int' },
  },
  Undo: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { 'actionId?': 'id' },
    response: { undid: 'string' },
  },
  SetSetting: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { key: 'string', value: 'primitive' },
    response: {},
  },
  ImportPreviewRequest: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: {
      fileMeta: { object: { name: 'string', size: 'int' } },
      // parserHint is an enum per §3 whose members live with the importer tier (E5).
      'parserHint?': 'string',
    },
    response: { previewId: 'id' },
  },
  ImportCommit: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { previewId: 'id', dedupeMode: { enum: ['skip', 'import-anyway'] } },
    response: { batchId: 'id', imported: 'int', dupes: 'int', rejects: 'int' },
  },
  ExportRequest: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: {
      scope: { oneOf: [{ enum: ['all'] }, { object: { mission: 'id' } }] },
      formats: { array: { enum: ['json', 'html', 'md'] } },
    },
    response: { exportId: 'id' },
  },
  RepairRebuild: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { scope: { oneOf: [{ enum: ['all'] }, 'string'] } },
    response: { rebuilt: 'unknown' }, // §3 names the field; projector-tier narrows it
  },
  RescueScanNow: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { mode: { enum: ['tail', 'full'] } },
    response: { reportId: 'id' },
  },
  ForgetEverything: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { confirm: { literal: true } },
    response: { artifactsPurged: 'int' },
  },
  ExportDiagnostics: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    payload: { 'includeAddresses?': 'boolean' },
    response: { bundleId: 'id' },
  },
  RestoreBootSession: {
    kind: 'command',
    family: 'command',
    availability: 'v1',
    // E6-T01 (user-ruled amendment, docs/adr-notes/e6-recovery-w7.md): W7's
    // "Put everything back → Resume intents per mission" (Blueprint §5.9) rides
    // ONE command — authority-free surfaces cannot enumerate affected missions,
    // so the service expands per-mission restores server-side. Additive; older
    // surfaces simply never send it. disclosure entries are STABLE TOKENS from
    // the report's receipts (never display copy — the catalog renders them).
    // E6-T02 (user-ruled amendment, docs/adr-notes/e6-recovery-crosscheck.md):
    // includeCandidates carries the panel's CONFIRMED cross-check urls (F2
    // extend-restore; bounded ≤25, snapshot-members only, plain tabs in one
    // trailing window); candidatesRestored answers how many actually opened.
    // Both additive-optional — older fixtures/fixtures-less sends stand.
    payload: { bootReportId: 'id', 'includeCandidates?': { array: 'string' } },
    response: {
      missionsRestored: 'int',
      tabsRestored: 'int',
      disclosure: { array: 'string' },
      'candidatesRestored?': 'int',
    },
  },
  NudgeDismiss: {
    kind: 'command',
    family: 'command',
    availability: 'v1.1',
    payload: { nudgeType: 'string' },
    response: {},
  },
  NudgeAccept: {
    kind: 'command',
    family: 'command',
    availability: 'v1.1',
    payload: { nudgeType: 'string', 'action?': { enum: ['park-selection'] } },
    response: {},
  },
  SwitchMission: {
    kind: 'command',
    family: 'command',
    availability: 'v1.1',
    payload: { parkCurrent: 'boolean', targetMissionId: 'id' },
    // §3 defers the Applied shape to Blueprint 6.8; Tier 2 narrows additively.
  },

  // ── §3.4 Queries (Surface → SW) ─────────────────────────────────────────────────
  GetBootstrap: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: { surface: { enum: ['guardian', 'overlay', 'quiet'] } },
    response: {
      snapshots: 'unknown',
      watermark: 'number',
      settings: 'unknown',
      heartbeat: 'unknown',
    },
  },
  GetLibrary: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: { 'filter?': 'unknown', 'sort?': 'string', 'cursor?': 'string' },
    response: { missions: { array: 'unknown' }, 'nextCursor?': 'string' },
  },
  GetMissionDetail: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: { missionId: 'id' },
    response: { mission: 'unknown', tabs: { array: 'unknown' }, artifacts: { array: 'unknown' } },
  },
  GetRecentlyClosed: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: { 'cursor?': 'string' },
    response: { entries: { array: 'unknown' }, 'nextCursor?': 'string' },
  },
  GetTrash: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: { 'cursor?': 'string' },
    response: { entries: { array: 'unknown' }, 'nextCursor?': 'string' },
  },
  SearchQuery: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: {
      q: { text: { maxLength: 200 } },
      'scope?': { enum: ['open', 'kept', 'closed', 'all'] },
      'limit?': 'int', // §3 bound ≤50 is a hub-side clamp alongside the scope-widen law
    },
    response: {
      results: { array: 'unknown' },
      freshness: 'string',
      searchedScopes: { array: 'string' },
    },
  },
  GetHealth: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: {},
    // Probe-registry dump: shape belongs to the diagnostics tier (EES §2.15).
  },
  PeekOpenTabs: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    payload: { 'windowId?': 'int' },
    // Live tab inventory: shape belongs to the TabsPort contract (EES §6).
  },
  GetBootReport: {
    kind: 'query',
    family: 'query',
    availability: 'v1',
    // E6-T01 (user-ruled amendment, docs/adr-notes/e6-recovery-w7.md): the W7
    // report fetch pairing the frozen RecoveryAvailable stream (§3.5 rows carry
    // no display copy — the surface reads the report, the catalog renders it).
    // Id-less call = the latest incident slot (the auto-opened quiet tab can
    // land after the fire-and-forget stream); an explicit id serves card-on-
    // demand reads. Response: the BootReport DTO (EES §2.13 schema v1) or null.
    // E6-T02 (user-ruled amendment, docs/adr-notes/e6-recovery-crosscheck.md):
    // the DTO carries crossCheckCandidates — the boot-TIME snapshot stored on
    // the incident slot (F3: computed once at incident creation, immutable;
    // never a live re-query). Additive-optional on the DTO, wire payload is
    // unchanged, so older readers stand.
    payload: { 'bootReportId?': 'id' },
  },

  // ── §3.5 Streams (SW → Surface) ─────────────────────────────────────────────────
  ViewDelta: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { view: 'string', watermark: 'number', ops: { array: 'unknown', maxItems: 500 } },
  },
  HeartbeatUpdate: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { keptCount: 'int', liveRecoverable: 'int', asOf: 'number' },
  },
  CommandAck: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { cid: 'id', intentId: 'id', state: { enum: ['accepted-pending'] } },
  },
  CommandApplied: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { cid: 'id', result: 'unknown' },
  },
  CommandFailed: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { cid: 'id', error: { object: ERROR_ENVELOPE_SPEC } },
  },
  NudgeOffered: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1.1',
    payload: { nudgeType: 'string', payloadRefs: 'unknown', dismissable: { literal: true } },
  },
  RecoveryAvailable: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { bootReportId: 'id', severity: { enum: ['loss-risk', 'clean-abnormal'] } },
  },
  HealthChanged: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { probes: 'unknown' },
  },
  ImportProgress: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { previewId: 'id', progress: 'unknown' },
  },
  ImportReady: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    // E5-T06 (user-ruled amendment, docs/adr-notes/e5-import-preview-ui.md):
    // modelSummary rides so the panel can show W15's "counts, detected structure"
    // — the shape key's declared surface purpose. Additive; older surfaces strip.
    payload: { previewId: 'id', modelSummary: 'string' },
  },
  ExportProgress: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { exportId: 'id', progress: 'unknown' },
  },
  ExportReady: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { fetchURL: 'string', manifestId: 'string', chunkChecksums: { array: 'string' } },
  },
  ResyncRequired: {
    kind: 'stream',
    family: 'stream',
    availability: 'v1',
    payload: { reason: { enum: ['gap', 'schema', 'death'] } },
  },

  // ── §3.6 Workroom (SW ↔ Offscreen) ──────────────────────────────────────────────
  EnsureWorkroom: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { reasonHint: 'string' },
  },
  WorkroomReady: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { capabilitiesResolved: 'unknown' },
  },
  JobOffer: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: {
      jobId: 'id',
      kind: 'string',
      payloadRef: 'unknown',
      lane: 'string',
      deadlineMs: 'number',
    },
  },
  JobClaimed: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { jobId: 'id', workerTag: 'string' },
  },
  JobHeartbeat: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { jobId: 'id', pct: 'number' },
  },
  JobResult: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { jobId: 'id', ok: 'boolean', 'artifact?': 'unknown', 'failureClass?': 'string' },
  },
  JobCancel: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { jobId: 'id' },
  },
  ParseRequest: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { previewId: 'id', fileRef: 'unknown' },
  },
  PreviewChunk: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { model: 'unknown' },
  },
  PreviewDone: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { previewId: 'id' },
  },
  IndexBuildRequest: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { scope: 'unknown' },
  },
  ChunkDone: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { count: 'int' },
  },
  IndexBuilt: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { tokenizerV: 'number' },
  },
  RenderRequest: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { exportId: 'id', formats: { array: 'string' } },
  },
  RenderChunkReady: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { fetchPartUrl: 'string' },
  },
  RenderReady: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { exportId: 'id', manifest: 'unknown' },
  },
  WorkroomShutdown: {
    kind: 'event',
    family: 'workroom',
    availability: 'v1',
    payload: { reason: { enum: ['idle'] } },
  },

  // ── §3.7 Future sync (v2-boundary; interfaces frozen, semantics Tier-4) ─────────
  DeviceRegister: {
    kind: 'event',
    family: 'sync',
    availability: 'v2-boundary',
    payload: { deviceId: 'string', sealedMeta: 'unknown' },
  },
  KeyBundlePublish: {
    kind: 'event',
    family: 'sync',
    availability: 'v2-boundary',
    payload: { deviceId: 'string', sealedKeyMaterial: 'unknown' },
  },
  SegmentsPush: {
    kind: 'event',
    family: 'sync',
    availability: 'v2-boundary',
    payload: { deviceId: 'string', segments: { array: 'unknown' } },
  },
  SegmentsPull: {
    kind: 'event',
    family: 'sync',
    availability: 'v2-boundary',
    payload: { deviceId: 'string', sinceSeq: 'number' },
  },
  RegistryList: {
    kind: 'event',
    family: 'sync',
    availability: 'v2-boundary',
    payload: {},
  },
};

/**
 * EES §3.1(f) Zone-1 law: consented page contexts (future content scripts) may send ONLY
 * names on this allowlist — indexing submissions, never high-trust commands (ADR-010).
 * v1 ships no content scripts, so the list is intentionally empty: the law's default is
 * deny-all, and the fixture proves enforcement holding even against a command name that
 * is perfectly valid from Zone-0. Add a name here only with an ADR + consent-sheet gate.
 */
export const ZONE1_ALLOWLIST: readonly string[] = [];
