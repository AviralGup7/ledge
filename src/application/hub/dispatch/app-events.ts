// E3-APP · Mission deliverable "Application events" — the typed in-process event bus.
// The dispatcher PUBLISHES lifecycle facts here; the streams hub (outbox slice)
// SUBSCRIBES and translates to frozen §3.5 wire names, so wire evolution never touches
// execution code. Everything crossing this bus is data-only (P-08 registry purity) and
// contains no display copy (§3.2).
import type { LedgeError } from '@/shared-kernel/result/index.js';
import type { ProgressEvent } from './progress.js';

/** Application-level lifecycle events (not wire names — the outbox owns translation). */
export type AppEvent =
  | {
      readonly type: 'command-ack';
      readonly cid: string;
      readonly command: string;
      /** Intent id for two-phase (durability-hinged) commands, when Bound. */
      readonly intentId?: string | undefined;
    }
  | {
      readonly type: 'command-applied';
      readonly cid: string;
      readonly command: string;
      /** Handler terminal result payload (DTO data, already mapped). */
      readonly result: unknown;
    }
  | {
      readonly type: 'command-failed';
      readonly cid: string;
      readonly command: string;
      readonly error: LedgeError;
    }
  | { readonly type: 'command-cancelled'; readonly cid: string; readonly command: string }
  | { readonly type: 'progress'; readonly event: ProgressEvent }
  | {
      /** Projection delta publication (ops are already per-view, watermark-ordered). */
      readonly type: 'view-delta';
      readonly view: string;
      readonly watermark: number;
      readonly ops: readonly unknown[];
    }
  | { readonly type: 'heartbeat'; readonly keptCount: number; readonly liveRecoverable: number };

export type AppEventListener = (event: AppEvent) => void;

/** Minimal typed pub/sub. Listeners never throw the publisher (isolated try/catch). */
export interface AppEventBus {
  readonly publish: (event: AppEvent) => void;
  readonly subscribe: (listener: AppEventListener) => () => void;
}

export const createAppEventBus = (): AppEventBus => {
  const listeners = new Set<AppEventListener>();
  return {
    publish: (event) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must never break the authority path (§2.6 hub invariants).
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
