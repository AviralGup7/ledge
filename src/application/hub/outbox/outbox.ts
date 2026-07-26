// E3-APP · Streams hub (outbox) — the single translation point from application
// lifecycle facts (AppEventBus) to the FROZEN §3.5 wire stream names. Wire evolution
// never touches execution code (dispatcher stays fluent on AppEvents; importers —
// and only this module — know wire vocabulary). Laws encoded here:
//  * WIRE-SHAPE PROOF: every emitted message passes validateObject against the
//    MESSAGE_REGISTRY payload spec of its name. Unspec'd/malformed emissions are
//    DROPPED into the sink (a programmer defect is observable, never published).
//  * §3.5 CommandAck accepted-pending exists for two-phase intent-hinged commands:
//    its intentId is a canonical Id. Synthetic pending tokens (resume-family call
//    sites that notify family strings) do NOT ride the wire — their terminal
//    CommandApplied carries everything the surface needs (adr-noted).
//  * R10 heartbeat law: HeartbeatUpdate recomputes POST-Applied only. Every
//    command-applied schedules a recompute; bursts coalesce (one in-flight +
//    one trailing), never stampede.
//  * ViewDelta ops are registry-clamped (maxItems 500); watermark REGRESSION per
//    view emits ResyncRequired{reason:'schema'} (rebuild publication). 'gap'/'death'
//    reasons belong to the recovery/compaction slice (adr-noted), never fabricated.
//  * Progress families (§3.3 timeout law): Import*/Export* command progress maps to
//    ImportProgress/ExportProgress ONLY when the ref is a canonical Id (previewId /
//    exportId / batchId); id-free progress stays bus-only (no wire carrier exists —
//    registry purity, never invented).
import type { AppEventBus, AppEvent } from '../dispatch/app-events.js';
import type { ViewDeltaFrame } from '@/application/ports/projection-engine.port.js';
import { MESSAGE_REGISTRY } from '@/application/contracts/message.registry.js';
import { validateObject } from '@/application/contracts/schema.js';
import { isId } from '@/shared-kernel/identity/index.js';
import type { Now } from '@/shared-kernel/identity/index.js';
import type { LedgeError } from '@/shared-kernel/result/index.js';

/** One frozen §3.5 stream message, post wire-shape proof. */
export interface WireStreamMessage {
  readonly name: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Observability sink for emissions the registry REJECTED (dev-defect audit, §2.11). */
export interface OutboxDrop {
  readonly name: string;
  readonly field: string;
}

export interface HeartbeatReadModel {
  readonly keptCount: number;
  readonly liveRecoverable: number;
  readonly asOf: number;
}

export interface OutboxDeps {
  readonly bus: AppEventBus;
  readonly publish: (message: WireStreamMessage) => void;
  /** R10 recompute seam (the query service's heartbeat read model, post-Applied). */
  readonly heartbeat: () => Promise<{ ok: true; value: HeartbeatReadModel } | { ok: false }>;
  readonly now: Now;
}

export interface Outbox {
  /** Projection-engine onDelta callback (composition root wires exactly this). */
  readonly onDelta: (frame: ViewDeltaFrame) => void;
  /** Subscribe to the application bus; returns the detach handle. */
  readonly start: () => () => void;
  /** Drops since creation (test + diagnostics seam). */
  readonly drops: () => readonly OutboxDrop[];
}

const VIEW_DELTA_OPS_MAX = 500;

const asErrorEnvelope = (error: LedgeError): Record<string, unknown> => ({
  code: error.code,
  retryable: error.retryable,
  messageKey: error.messageKey,
  recoveryKey: error.recoveryKey,
  ...(error.details !== undefined ? { details: error.details } : {}),
});

const progressFields = (e: {
  readonly stage: number;
  readonly current?: number | undefined;
  readonly total?: number | undefined;
}): Record<string, unknown> => ({
  stage: e.stage,
  ...(e.current !== undefined ? { current: e.current } : {}),
  ...(e.total !== undefined ? { total: e.total } : {}),
});

export const createOutbox = (deps: OutboxDeps): Outbox => {
  const dropLog: OutboxDrop[] = [];

  /**
   * The ONLY publish path: wire-name lookup + payload proof. A failure lands in the
   * drop log (observable defect), byte-perfect emissions alone reach the transport.
   */
  const emit = (name: string, payload: Record<string, unknown>): boolean => {
    const spec = MESSAGE_REGISTRY[name]?.payload;
    if (spec === undefined) {
      dropLog.push({ name, field: 'name' });
      return false;
    }
    const checked = validateObject(spec, payload, { message: name, field: '' }, 0);
    if (!checked.ok) {
      dropLog.push({ name, field: checked.error.details?.['field']?.toString() ?? 'payload' });
      return false;
    }
    deps.publish({ name, payload: checked.value.normalized });
    return true;
  };

  // ── R10 heartbeat: post-Applied recompute, coalesced (one in-flight + trailing). ──
  let heartbeatInFlight = false;
  let heartbeatTrailing = false;
  const scheduleHeartbeat = (): void => {
    if (heartbeatInFlight) {
      heartbeatTrailing = true;
      return;
    }
    heartbeatInFlight = true;
    void deps
      .heartbeat()
      .then((r) => {
        if (r.ok) {
          emit('HeartbeatUpdate', {
            keptCount: r.value.keptCount,
            liveRecoverable: r.value.liveRecoverable,
            asOf: r.value.asOf,
          });
        }
      })
      .finally(() => {
        heartbeatInFlight = false;
        if (heartbeatTrailing) {
          heartbeatTrailing = false;
          scheduleHeartbeat();
        }
      });
  };

  // ── View deltas + watermark-regression resync law. ────────────────────────────────
  // Wire watermark = seq scalar (§3.5 shape is frozen as 'number'); the positioned
  // (deviceId, seq, batchIndex) watermark stays application-internal (multi-device
  // surfacing lands with sync in v2 — v1 serves the local device stream).
  const watermarkByView = new Map<string, number>();
  /** ADR-010 wire window: exactly the four surface-consumed views. E5-T01 adds
   *  engine-internal views ('searchIndex') whose frames must NEVER ride the wire —
   *  surfaces hold no pk catalog for them and would misread them as resync signals. */
  const WIRE_VIEWS = new Set(['missions', 'recentlyClosed', 'sessions', 'tabs']);
  const publishDelta = (view: string, seq: number, ops: readonly unknown[]): void => {
    if (!WIRE_VIEWS.has(view)) return;
    const previous = watermarkByView.get(view);
    if (previous !== undefined && seq < previous) {
      // Projection rebuild publication: every surface must resync (its local watermark
      // is now AHEAD of truth — post-rebuild frames replay from a lower sequence).
      emit('ResyncRequired', { reason: 'schema' });
    }
    watermarkByView.set(view, seq);
    emit('ViewDelta', { view, watermark: seq, ops: ops.slice(0, VIEW_DELTA_OPS_MAX) });
  };
  const onDelta = (frame: ViewDeltaFrame): void =>
    publishDelta(frame.view, frame.watermark.seq, frame.ops);

  // ── Bus translation (lifecycle facts → §3.5 stream names). ────────────────────────
  const appliedResult = (e: Extract<AppEvent, { readonly type: 'command-applied' }>): void => {
    emit('CommandApplied', { cid: e.cid, result: e.result });
    if (e.command === 'ImportPreviewRequest') {
      const result = e.result as Record<string, unknown> | null;
      const previewId = result?.['previewId'];
      const modelSummary = result?.['modelSummary'];
      // The service value carries the census (ImportPreviewed journalled upstream);
      // the amended row delivers it to every surface, not just the requester.
      if (isId(previewId) && typeof modelSummary === 'string')
        emit('ImportReady', { previewId, modelSummary });
    }
    if (e.command === 'ExportRequest') {
      // ExportReady's frozen fields (fetchURL/manifestId/chunkChecksums) are the E5
      // fetch machinery's material; an exporter plan without them emits nothing.
      const result = e.result as Record<string, unknown> | null;
      if (
        typeof result?.['fetchURL'] === 'string' &&
        typeof result['manifestId'] === 'string' &&
        Array.isArray(result['chunkChecksums'])
      ) {
        emit('ExportReady', {
          fetchURL: result['fetchURL'],
          manifestId: result['manifestId'],
          chunkChecksums: result['chunkChecksums'],
        });
      }
    }
    scheduleHeartbeat(); // R10: post-Applied recompute, every applied command.
  };

  const onBusEvent = (e: AppEvent): void => {
    switch (e.type) {
      case 'command-ack': {
        if (isId(e.intentId)) {
          emit('CommandAck', { cid: e.cid, intentId: e.intentId, state: 'accepted-pending' });
        }
        return;
      }
      case 'command-applied': {
        appliedResult(e);
        return;
      }
      case 'command-failed': {
        emit('CommandFailed', { cid: e.cid, error: asErrorEnvelope(e.error) });
        return;
      }
      case 'command-cancelled': {
        // §3.5 has no wire carrier for cancellation in v1 — the terminal Failed
        // (E_CANCELLED) the dispatcher emits next carries it. Never invent streams.
        return;
      }
      case 'progress': {
        const { command, ref } = e.event;
        if (command.startsWith('Import') && isId(ref)) {
          emit('ImportProgress', { previewId: ref, progress: progressFields(e.event) });
        }
        if (command.startsWith('Export') && isId(ref)) {
          emit('ExportProgress', { exportId: ref, progress: progressFields(e.event) });
        }
        return;
      }
      case 'view-delta': {
        // Bus-carried delta: its watermark is ALREADY the wire scalar (the AppEvent
        // shape is the surface-facing mirror), no positioned translation needed.
        publishDelta(e.view, e.watermark, e.ops);
        return;
      }
      case 'heartbeat': {
        emit('HeartbeatUpdate', {
          keptCount: e.keptCount,
          liveRecoverable: e.liveRecoverable,
          asOf: deps.now(),
        });
        return;
      }
    }
  };

  return {
    onDelta,
    start: () => deps.bus.subscribe(onBusEvent),
    drops: () => [...dropLog],
  };
};
