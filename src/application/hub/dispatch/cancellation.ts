// E3-APP · Mission deliverable "Cancellation" — cooperative per-command cancellation.
// The dispatcher owns one registry keyed by cid; surfaces cancel through CancelCommand
// (internal) or transport teardown. Cancellation is a COOPERATIVE LATTICE: handlers
// observe the token at phase boundaries via throwIfCancelled, so a mid-flight park
// intent is never half-aborted (the executor runs to its own terminal law).
import { ledgeError, type LedgeError } from '@/shared-kernel/result/index.js';

/** Token handed to handlers inside the execution context. */
export interface CancelToken {
  readonly cid: string;
  readonly isCancelled: () => boolean;
  /** Cooperative checkpoint — throws CancelledMarker when cancellation was requested. */
  readonly throwIfCancelled: () => void;
}

/** Internal marker (contained by the dispatcher into a Failed terminal, never thrown over the wire). */
export interface CancelledMarker {
  readonly kind: 'cancelled';
  readonly cid: string;
}

const CancelledMarkerNominal = (cid: string): CancelledMarker => ({ kind: 'cancelled', cid });

export const isCancelledMarker = (e: unknown): e is CancelledMarker =>
  typeof e === 'object' &&
  e !== null &&
  (e as { kind?: unknown }).kind === 'cancelled' &&
  typeof (e as { cid?: unknown }).cid === 'string';

/**
 * Terminal error for a cancelled operation. E_CAPABILITY per closed catalog law
 * (ADR-033: no new codes without an ADR); details.flag marks the cancellation so a
 * surface can whisper "Stopped." without alarming copy.
 */
export const cancelledTerminalError = (operation: string, cid: string): LedgeError =>
  ledgeError('E_CAPABILITY', { operation, cancelled: 1, cid });

interface OperationEntry {
  readonly cid: string;
  cancelled: boolean;
  readonly listeners: Set<() => void>;
}

/**
 * Registry of in-flight operations. Single-threaded SW model: the flag flips
 * synchronously on cancel and handlers observe it between awaits — a hard-stop
 * AbortController cannot express the durability lattice (some phases must finish).
 */
export interface CancellationRegistry {
  readonly register: (cid: string) => CancelToken;
  readonly cancel: (cid: string) => boolean;
  readonly isCancelled: (cid: string) => boolean;
  readonly forget: (cid: string) => void;
  readonly size: () => number;
}

export const createCancellationRegistry = (): CancellationRegistry => {
  const operations = new Map<string, OperationEntry>();
  return {
    register: (cid) => {
      const entry: OperationEntry = { cid, cancelled: false, listeners: new Set() };
      operations.set(cid, entry);
      return {
        cid,
        isCancelled: () => entry.cancelled,
        throwIfCancelled: () => {
          if (entry.cancelled) throw CancelledMarkerNominal(cid);
        },
      };
    },
    cancel: (cid) => {
      const entry = operations.get(cid);
      if (entry === undefined || entry.cancelled) return false;
      entry.cancelled = true;
      return true;
    },
    isCancelled: (cid) => operations.get(cid)?.cancelled ?? false,
    forget: (cid) => {
      operations.delete(cid);
    },
    size: () => operations.size,
  };
};
