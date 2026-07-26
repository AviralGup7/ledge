// E2-T03 · ProjectionEnginePort — EES §2.10: events → disposable, rebuildable read
// models; watermarks; delta publication (§3.5 ViewDelta). Invariants encoded here:
//  (idempotent) re-applying an event under the watermark is a zero-op skip;
//  (order) per-aggregate event order (seq, batchIndex) is preserved;
//  (disposable) rebuild(view) replays the journal and produces IDENTICAL output —
//    the determinism law this task's property suite proves;
//  (dirty) a throwing projector marks its view dirty, freezes its watermark, and never
//    poisons its peers; rebuild is the recovery path.
import type { StoreName } from './storage-stores.catalog.js';
import type { StoredRecord } from './storage-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** v1 view surface (register per view; grows as use-cases land E3+).
 *  E3-APP: 'tabs' joins — per-tab lifecycle truth (LIVE|KEPT|TRASH) is the read
 *  foundation of C7/C10/C15/C16 + R10 heartbeat semantics. */
export type ViewName = 'missions' | 'recentlyClosed' | 'sessions' | 'tabs';

/** §2.10 watermark: highest APPLIED (seq, batchIndex) per (view, device). */
export type Watermark = {
  readonly deviceId: DeviceId;
  readonly seq: number;
  readonly batchIndex: number;
};

/** §3.5 op vocabulary (patch = shallow field merge; upsert = full replace). */
export type DeltaOp =
  | { readonly kind: 'upsert'; readonly key: string; readonly record: StoredRecord }
  | { readonly kind: 'remove'; readonly key: string }
  | {
      readonly kind: 'patch';
      readonly key: string;
      readonly fields: Readonly<Record<string, unknown>>;
    };

/** §3.5 ViewDelta frame; ops ≤ FRAME_OPS_CAP (engine chunks larger bursts). */
export type ViewDeltaFrame = {
  readonly view: ViewName;
  readonly watermark: Watermark;
  readonly ops: readonly DeltaOp[];
};

export type ApplyReport = {
  readonly applied: number;
  readonly skippedBelowWatermark: number;
  /** Views that threw during this drive (marked dirty; frozen until rebuild). */
  readonly dirtied: readonly ViewName[];
};

export type RebuildReport = {
  readonly view: ViewName;
  readonly eventsApplied: number;
};

export type ProjectionViewStatus = {
  readonly view: ViewName;
  readonly projectorV: number;
  readonly dirty: boolean;
  readonly watermarks: readonly Watermark[];
};

export type ProjectionStatus = {
  readonly views: readonly ProjectionViewStatus[];
};

/** Projector definition: pure event → ops mapping, store-scoped (per-aggregate reads). */
export interface ProjectorDef {
  readonly view: ViewName;
  readonly store: StoreName;
  /**
   * E3-APP registry-growth law: the store's plain string pk field, declared by the
   * projector (patch-materialization + rebuild-wipe addressing derive from it).
   * Compound-pk stores (sessions: [snapshotId+partIndex]) OMIT it — the engine's
   * tuple-key wipe law covers them. Growth beyond the E2 reference set must not
   * require engine core edits (fc seed -159411701 class, tabs view).
   */
  readonly keyField?: string | undefined;
  /** Bump ⇒ rebuild-on-change (§2.10 versioning law: recorded with watermarks). */
  readonly projectorV: number;
  /**
   * Map one event to store ops. `read` consults THIS projector's store (current txn
   * state incl. same-chunk writes); everything derives from the journal, determinism
   * holds by construction. Must be upsert-idempotent (apply-twice = apply-once).
   */
  readonly project: (
    event: EventEnvelope,
    read: (key: string) => Promise<StoredRecord | undefined>,
  ) => Promise<readonly DeltaOp[]>;
}

export type DeltaSubscriber = (frame: ViewDeltaFrame) => void;

export interface ProjectionEnginePort {
  /**
   * Drive a batch of stamped events (ingest path, E2-T05). Groups per device, applies
   * in (seq, batchIndex), chunks txns (a kill mid-drive resumes from the watermark —
   * recovery-after-interrupted-replay law).
   */
  apply(events: readonly EventEnvelope[]): Promise<Result<ApplyReport, LedgeError>>;
  /** Replay this device's journal stream from 0 through the engine (below-wm skipped). */
  applyFromJournal(deviceId: DeviceId): Promise<Result<ApplyReport, LedgeError>>;
  /**
   * Disposable-model law: wipe the view's rows + watermark, replay the journal,
   * produce identical output. The determinism-law property rides on this.
   */
  rebuild(view: ViewName): Promise<Result<RebuildReport, LedgeError>>;
  /** Watermarks + projector versions + dirty set (health probes read this). */
  status(): Promise<Result<ProjectionStatus, LedgeError>>;
}
