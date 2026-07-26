// E4 · View store — surface-local copy of view snapshots, updated by §3.5 ViewDelta
// frames. This is stream DESERIALIZATION, never projection logic: ops arrive with
// their store key already computed ({kind:'upsert'|'remove'|'patch', key, …}) and the
// store applies them mechanically. No derivation, no aggregation, no state machine —
// seeds come from GetBootstrap/Get* queries whose payloads are already display DTOs.
import { copyOf } from '../copy/copy.js';

/** Row = the record carried by a delta op or bootstrap snapshot (display DTO shape). */
export type ViewRow = Readonly<Record<string, unknown>>;

export interface ViewDeltaOp {
  readonly kind: 'upsert' | 'remove' | 'patch';
  readonly key: string;
  readonly record?: ViewRow | undefined;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

export interface ViewFrame {
  readonly view: string;
  readonly watermark: number;
  readonly ops: readonly ViewDeltaOp[];
}

/**
 * §5/§A store pk per view — wire-shape knowledge from the frozen catalog (the delta
 * frames only carry `key`; bootstrap snapshots arrive as bare rows, so seeding needs
 * the same pk names the ops already embed). Four views, additive-only growth.
 */
export const VIEW_PRIMARY_KEY: Readonly<Record<string, string>> = {
  missions: 'missionId',
  tabs: 'ledgeTabId',
  sessions: 'snapshotId',
  recentlyClosed: 'entryId',
};

export type StoreEvent =
  | { readonly kind: 'seed'; readonly view: string; readonly watermark: number | undefined }
  | { readonly kind: 'delta'; readonly view: string; readonly watermark: number }
  | {
      readonly kind: 'gap';
      readonly view: string;
      readonly expected: number;
      readonly got: number;
    };

export interface ViewStore {
  /** Replace a view wholesale (bootstrap / full rejoin / refetch-on-resync). */
  readonly seed: (view: string, rows: readonly ViewRow[], watermark: number | undefined) => void;
  /** Apply one §3.5 frame. 'gap' ⇒ nothing applied; the caller refetches (law: gap ⇒
   *  ResyncRequired ⇒ full snapshot rejoin — partial truth is never rendered). */
  readonly applyFrame: (frame: ViewFrame) => 'applied' | 'duplicate' | 'gap' | 'reset';
  readonly rows: (view: string) => readonly ViewRow[];
  readonly row: (view: string, key: string) => ViewRow | undefined;
  readonly watermarkOf: (view: string) => number | undefined;
  readonly subscribe: (listener: (event: StoreEvent) => void) => () => void;
  readonly dispose: () => void;
}

const rowKeyOf = (view: string, row: ViewRow): string | undefined => {
  const pk = VIEW_PRIMARY_KEY[view];
  if (pk === undefined) return undefined;
  const v = row[pk];
  return typeof v === 'string' ? v : undefined;
};

const parseOp = (raw: unknown): ViewDeltaOp | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  const key = r['key'];
  if (typeof key !== 'string') return undefined;
  if (kind === 'upsert') {
    const record = r['record'];
    if (typeof record !== 'object' || record === null) return undefined;
    return { kind, key, record: record as ViewRow };
  }
  if (kind === 'remove') return { kind, key };
  if (kind === 'patch') {
    const fields = r['fields'];
    if (typeof fields !== 'object' || fields === null) return undefined;
    return { kind, key, fields: fields as Readonly<Record<string, unknown>> };
  }
  return undefined;
};

/** Narrow a raw stream payload to a frame (defensive shape check = transport law,
 *  never schema re-validation — the outbox already proved the wire shape). */
export const viewFrameOf = (payload: unknown): ViewFrame | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const view = p['view'];
  const watermark = p['watermark'];
  const ops = p['ops'];
  if (typeof view !== 'string' || typeof watermark !== 'number' || !Array.isArray(ops))
    return undefined;
  const parsed: ViewDeltaOp[] = [];
  for (const raw of ops) {
    const op = parseOp(raw);
    if (op === undefined) return undefined;
    parsed.push(op);
  }
  return { view, watermark, ops: parsed };
};

export const createViewStore = (): ViewStore => {
  const views = new Map<string, Map<string, ViewRow>>();
  const watermarks = new Map<string, number>();
  const listeners = new Set<(event: StoreEvent) => void>();

  const emit = (event: StoreEvent): void => {
    for (const l of listeners) l(event);
  };

  const viewMap = (view: string): Map<string, ViewRow> => {
    let m = views.get(view);
    if (m === undefined) {
      m = new Map();
      views.set(view, m);
    }
    return m;
  };

  return {
    seed: (view, rows, watermark) => {
      const m = new Map<string, ViewRow>();
      for (const row of rows) {
        const key = rowKeyOf(view, row);
        if (key !== undefined) m.set(key, row);
      }
      views.set(view, m);
      if (watermark !== undefined) watermarks.set(view, watermark);
      else watermarks.delete(view);
      emit({ kind: 'seed', view, watermark });
    },

    applyFrame: (frame) => {
      if (VIEW_PRIMARY_KEY[frame.view] === undefined) return 'reset';
      const current = watermarks.get(frame.view);
      if (current !== undefined) {
        if (frame.watermark === current) return 'duplicate';
        if (frame.watermark > current + 1) {
          emit({
            kind: 'gap',
            view: frame.view,
            expected: current + 1,
            got: frame.watermark,
          });
          return 'gap';
        }
        if (frame.watermark < current) {
          // Truth regressed (SW rebuild): partial render is forbidden — caller rejoins.
          emit({
            kind: 'gap',
            view: frame.view,
            expected: current + 1,
            got: frame.watermark,
          });
          return 'gap';
        }
      }
      const m = viewMap(frame.view);
      for (const op of frame.ops) {
        if (op.kind === 'remove') {
          m.delete(op.key);
        } else if (op.kind === 'upsert' && op.record !== undefined) {
          m.set(op.key, op.record);
        } else if (op.kind === 'patch') {
          const existing = m.get(op.key);
          const base: Record<string, unknown> = existing === undefined ? {} : { ...existing };
          for (const [k, v] of Object.entries(op.fields ?? {})) base[k] = v;
          m.set(op.key, base);
        }
      }
      watermarks.set(frame.view, frame.watermark);
      emit({ kind: 'delta', view: frame.view, watermark: frame.watermark });
      return 'applied';
    },

    rows: (view) => [...viewMap(view).values()],
    row: (view, key) => viewMap(view).get(key),
    watermarkOf: (view) => watermarks.get(view),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      listeners.clear();
      views.clear();
      watermarks.clear();
    },
  };
};

/** Copy helper: the resync banner line (shared by every surface). */
export const resyncCopy = (): string => copyOf('msg.state.resync');
