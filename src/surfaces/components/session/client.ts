// E4 · Wire client — the surface's only channel to authority. Everything authority
// does crosses here as: envelopes OUT ({v,kind,name,cid,senderContext,payload,
// contractHash}, §3.1) and stream messages IN ({v,kind:'stream',name,payload}, §3.5).
// The client contains NO business logic: it correlates ids, tracks two-phase honesty
// (EES R1 — acknowledged-pending until Applied, never optimistic truth), and offers
// watermark bookkeeping for the §3.5 gap law. Validation stays SW-side (rule (a));
// the client never re-implements it — it only refuses to crash.
import {
  CONTRACT_V,
  computeContractHash,
  type SenderContext,
} from '@/application/contracts/index.js';
import type { CidEntropy } from './ids.js';
import { createCidMinter } from './ids.js';

/** Flat wire copy of the §3.2 error envelope (codes copy is rendered from the catalog). */
export interface WireError {
  readonly code: string;
  readonly retryable?: boolean | undefined;
  readonly messageKey?: string | undefined;
  readonly recoveryKey?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/** What the SW answered synchronously to a send (dispatch() outcome per §2.6). */
export type AckOutcome =
  | { readonly outcome: 'ack' }
  | { readonly outcome: 'ignored'; readonly reason?: string | undefined }
  | { readonly outcome: 'rejected'; readonly error: WireError }
  | { readonly outcome: 'unreachable' };

/** Terminal per the dispatcher's exactly-one law (rides CommandApplied/Failed streams). */
export type TerminalOutcome =
  | { readonly ok: true; readonly value: unknown; readonly cancelled: boolean }
  | { readonly ok: false; readonly error: WireError; readonly cancelled: boolean };

/** Two-phase operation phases (R1: pending exists between Ack and terminal). */
export type PendingPhase = 'sent' | 'acknowledged' | 'applied' | 'failed';

export interface PendingOperation {
  readonly cid: string;
  readonly name: string;
  readonly phase: PendingPhase;
  readonly intentId?: string | undefined;
  readonly since: number;
}

export interface OperationHandle {
  readonly cid: string;
  readonly ack: Promise<AckOutcome>;
  /** Resolves exactly once (dispatcher law); 'unreachable' resolves the terminal too
   *  (a send that never arrived can have no stream terminal — surfaced as failed:
   *  the action did NOT happen, the copy says so, and only the user may resend). */
  readonly terminal: Promise<TerminalOutcome>;
}

/** The frozen §3.5 stream vocabulary (EES §3.5 / registry stream family, 13 names). */
export const WIRE_STREAMS = [
  'ViewDelta',
  'HeartbeatUpdate',
  'CommandAck',
  'CommandApplied',
  'CommandFailed',
  'NudgeOffered',
  'RecoveryAvailable',
  'HealthChanged',
  'ImportProgress',
  'ImportReady',
  'ExportProgress',
  'ExportReady',
  'ResyncRequired',
] as const;
export type StreamName = (typeof WIRE_STREAMS)[number];

export type StreamHandlers = Partial<Record<StreamName, (payload: unknown) => void>> & {
  readonly onAny?: ((name: StreamName, payload: unknown) => void) | undefined;
};

/** Transport seam — roots bind chrome.runtime; tests bind fakes (A-02 containment:
 *  surfaces never see the `chrome` global). */
export interface WireTransport {
  readonly send: (message: unknown) => Promise<unknown>;
  readonly listen: (listener: (message: unknown) => void) => () => void;
}

export interface WireClientDeps {
  readonly context: SenderContext;
  readonly transport: WireTransport;
  readonly entropy: CidEntropy;
  /** Build-hash seam (production computes from the live registry; both sides agree
   *  per ADR-010's dual-read window). */
  readonly contractHash?: string | undefined;
}

/** A send whose ack never produced a terminal within this window is swept from the
 *  pending ledger as failed-expired (memory law) — the op's own lifecycle is over. */
const PENDING_TTL_MS = 600_000;
const PENDING_CAP = 64;

interface PendingEntry {
  readonly name: string;
  readonly since: number;
  phase: PendingPhase;
  intentId?: string | undefined;
  resolveTerminal: (t: TerminalOutcome) => void;
}

interface Envelope {
  readonly v: number;
  readonly kind: 'command' | 'query';
  readonly name: string;
  readonly cid: string;
  readonly senderContext: SenderContext;
  readonly payload: unknown;
  readonly contractHash: string;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const asWireError = (v: unknown): WireError => {
  const r = asRecord(v);
  if (r === undefined) return { code: 'E_FORMAT_UNKNOWN' };
  return {
    code: typeof r['code'] === 'string' ? r['code'] : 'E_FORMAT_UNKNOWN',
    ...(typeof r['retryable'] === 'boolean' ? { retryable: r['retryable'] } : {}),
    ...(typeof r['messageKey'] === 'string' ? { messageKey: r['messageKey'] } : {}),
    ...(typeof r['recoveryKey'] === 'string' ? { recoveryKey: r['recoveryKey'] } : {}),
    ...(r['details'] !== undefined
      ? { details: (asRecord(r['details']) ?? {}) as Readonly<Record<string, unknown>> }
      : {}),
  };
};

const parseAck = (raw: unknown): AckOutcome => {
  const r = asRecord(raw);
  const outcome = r?.['outcome'];
  if (outcome === 'ack') return { outcome: 'ack' };
  if (outcome === 'ignored') {
    return {
      outcome: 'ignored',
      ...(typeof r?.['reason'] === 'string' ? { reason: r['reason'] } : {}),
    };
  }
  if (outcome === 'rejected') return { outcome: 'rejected', error: asWireError(r?.['error']) };
  return { outcome: 'unreachable' };
};

/** A stream message after name validation — the name is proven to be one of the 13. */
interface ValidStreamMessage {
  readonly name: StreamName;
  readonly payload: Readonly<Record<string, unknown>>;
}

const streamMessageOf = (raw: unknown): ValidStreamMessage | undefined => {
  const r = asRecord(raw);
  if (r === undefined || r['v'] !== CONTRACT_V || r['kind'] !== 'stream') return undefined;
  const name = r['name'];
  if (typeof name !== 'string' || !(WIRE_STREAMS as readonly string[]).includes(name))
    return undefined;
  return {
    name: name as StreamName,
    payload: (asRecord(r['payload']) ?? {}) as Readonly<Record<string, unknown>>,
  };
};

export interface WireClient {
  readonly context: SenderContext;
  readonly contractHash: string;
  readonly command: (name: string, payload: unknown) => OperationHandle;
  readonly query: (name: string, payload: unknown) => OperationHandle;
  /** Subscribe to the §3.5 stream family; returns the detach handle (cleanup law:
   *  unmount releases every subscription). */
  readonly subscribe: (handlers: StreamHandlers) => () => void;
  /** Live pending ledger (Guardian's R1 pending strip renders off this). */
  readonly pending: () => readonly PendingOperation[];
  /** §3.5 watermark bookkeeping; the caller decides what a gap means (resync). */
  readonly noteWatermark: (view: string, seq: number) => 'ok' | 'duplicate' | 'gap';
  readonly watermarkOf: (view: string) => number | undefined;
  /** After a full snapshot rejoin the per-view watermarks reset to the new base. */
  readonly resetWatermarks: (base: Readonly<Record<string, number>>) => void;
  /** Release pending ledger + detach everything (unmount / memory-safety law). */
  readonly dispose: () => void;
}

export const createWireClient = (deps: WireClientDeps): WireClient => {
  const hash = deps.contractHash ?? computeContractHash();
  const mint = createCidMinter(deps.entropy);
  const pendingLedger = new Map<string, PendingEntry>();
  const watermarks = new Map<string, number>();
  const streamSubscribers = new Set<(message: ValidStreamMessage) => void>();

  const sweepExpired = (): void => {
    const now = deps.entropy.now();
    for (const [cid, entry] of pendingLedger) {
      if (now - entry.since > PENDING_TTL_MS) {
        pendingLedger.delete(cid);
        entry.resolveTerminal({
          ok: false,
          cancelled: false,
          error: {
            code: 'E_DURABILITY_TIMEOUT',
            messageKey: 'msg.error.durability',
            recoveryKey: 'msg.recover.retry',
          },
        });
      }
    }
  };

  const envelope = (kind: 'command' | 'query', name: string, payload: unknown): Envelope => ({
    v: CONTRACT_V,
    kind,
    name,
    cid: mint(),
    senderContext: deps.context,
    payload,
    contractHash: hash,
  });

  const settle = (cid: string, terminal: TerminalOutcome): void => {
    const entry = pendingLedger.get(cid);
    if (entry === undefined) return;
    entry.phase = terminal.ok ? 'applied' : 'failed';
    entry.resolveTerminal(terminal);
    // Ledger retains the settled row briefly for the pending strip, then sweeps.
    pendingLedger.delete(cid);
  };

  const routeStream = (message: ValidStreamMessage): void => {
    if (message.name === 'CommandAck') {
      const cid = message.payload['cid'];
      const intentId = message.payload['intentId'];
      if (typeof cid === 'string') {
        const entry = pendingLedger.get(cid);
        if (entry !== undefined) {
          entry.phase = 'acknowledged';
          if (typeof intentId === 'string') entry.intentId = intentId;
        }
      }
    }
    if (message.name === 'CommandApplied' || message.name === 'CommandFailed') {
      const cid = message.payload['cid'];
      if (typeof cid === 'string') {
        if (message.name === 'CommandApplied') {
          settle(cid, { ok: true, value: message.payload['result'], cancelled: false });
        } else {
          settle(cid, {
            ok: false,
            error: asWireError(message.payload['error']),
            cancelled: false,
          });
        }
      }
    }
    for (const subscriber of streamSubscribers) subscriber(message);
  };

  const detachTransport = deps.transport.listen((raw) => {
    const message = streamMessageOf(raw);
    if (message !== undefined) routeStream(message);
  });

  const send = (kind: 'command' | 'query', name: string, payload: unknown): OperationHandle => {
    sweepExpired();
    if (pendingLedger.size >= PENDING_CAP) {
      // Never drop silently: the oldest unsettled entry expires first (bounded memory).
      const oldest = pendingLedger.keys().next().value;
      if (oldest !== undefined) {
        const entry = pendingLedger.get(oldest);
        pendingLedger.delete(oldest);
        entry?.resolveTerminal({
          ok: false,
          cancelled: false,
          error: {
            code: 'E_DURABILITY_TIMEOUT',
            messageKey: 'msg.error.durability',
            recoveryKey: 'msg.recover.wait',
          },
        });
      }
    }
    const env = envelope(kind, name, payload);
    let resolveTerminal!: (t: TerminalOutcome) => void;
    const terminal = new Promise<TerminalOutcome>((resolve) => {
      resolveTerminal = resolve;
    });
    const entry: PendingEntry = {
      name,
      since: deps.entropy.now(),
      phase: 'sent',
      resolveTerminal,
    };
    pendingLedger.set(env.cid, entry);

    const ack: Promise<AckOutcome> = deps.transport
      .send(env)
      .then((raw) => parseAck(raw))
      .catch((): AckOutcome => ({ outcome: 'unreachable' }));
    void ack.then((a) => {
      if (a.outcome === 'ack') return; // terminal arrives on the stream (R1)
      const finalError: WireError =
        a.outcome === 'rejected'
          ? a.error
          : a.outcome === 'ignored'
            ? {
                code: 'E_OUTPUT_MALFORMED',
                messageKey: 'msg.error.output',
                recoveryKey: 'msg.recover.retry',
              }
            : {
                code: 'E_CAPABILITY',
                messageKey: 'msg.error.capability',
                recoveryKey: 'msg.recover.retry',
              };
      settle(env.cid, { ok: false, error: finalError, cancelled: false });
    });

    return { cid: env.cid, ack, terminal };
  };

  return {
    context: deps.context,
    contractHash: hash,
    command: (name, payload) => send('command', name, payload),
    query: (name, payload) => send('query', name, payload),
    subscribe: (handlers) => {
      const subscriber = (message: ValidStreamMessage): void => {
        handlers.onAny?.(message.name, message.payload);
        const specific = handlers[message.name];
        if (specific !== undefined) specific(message.payload);
      };
      streamSubscribers.add(subscriber);
      return () => {
        streamSubscribers.delete(subscriber);
      };
    },
    pending: () =>
      [...pendingLedger.entries()].map(([cid, e]) => ({
        cid,
        name: e.name,
        phase: e.phase,
        since: e.since,
        ...(e.intentId !== undefined ? { intentId: e.intentId } : {}),
      })),
    noteWatermark: (view, seq) => {
      const current = watermarks.get(view);
      if (current === undefined) {
        watermarks.set(view, seq);
        return 'ok';
      }
      if (seq === current) return 'duplicate';
      if (seq !== current + 1) return 'gap';
      watermarks.set(view, seq);
      return 'ok';
    },
    watermarkOf: (view) => watermarks.get(view),
    resetWatermarks: (base) => {
      watermarks.clear();
      for (const [view, seq] of Object.entries(base)) watermarks.set(view, seq);
    },
    dispose: () => {
      for (const [, entry] of pendingLedger) {
        entry.resolveTerminal({
          ok: false,
          cancelled: false,
          error: {
            code: 'E_CAPABILITY',
            messageKey: 'msg.error.capability',
            recoveryKey: 'msg.recover.restart',
          },
        });
      }
      pendingLedger.clear();
      streamSubscribers.clear();
      detachTransport();
    },
  };
};
