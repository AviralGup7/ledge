// E4 testkit · Fake wire transport + entropy — the SW-side of the §3.1/§3.5 wire
// without a browser. The fake records every envelope the surface sends (checked by
// tests against the frozen registry) and answers acks through a scriptable
// responder; streams are emitted into the surface's listener exactly like the
// outbox's guardedBroadcast does ({v, kind:'stream', name, payload}).
// E4-FIX-01 (audit F2): the fake is also a BOUNDARY VALIDATOR — every envelope is
// fail-fast validated against the frozen registry at send time (name resolves,
// wire-kind parity, payload through validateObject, senderContext in the enum).
// A shape drift at a call site now throws loudly in the suite that caused it;
// it can never again pass on a hand-mirrored fixture alone.
import {
  CONTRACT_V,
  MESSAGE_REGISTRY,
  SENDER_CONTEXTS,
  validateObject,
  type SchemaSpec,
} from '@/application/contracts/index.js';
import { INTERNAL_COMMANDS, INTERNAL_QUERIES } from '@/application/usecases/handlers.js';
import type { CidEntropy } from '@/surfaces/components/session/ids.js';
import type { WireTransport } from '@/surfaces/components/session/client.js';

export interface SentEnvelope {
  readonly v: number;
  readonly kind: 'command' | 'query';
  readonly name: string;
  readonly cid: string;
  readonly senderContext: string;
  readonly payload: unknown;
  readonly contractHash: string;
}

const INTERNAL_NAMES = new Set<string>([
  ...INTERNAL_COMMANDS.map((registration) => registration.name),
  ...INTERNAL_QUERIES.map((registration) => registration.name),
]);

/** Fail-fast wire-law validation, executed on EVERY send the surface makes through
 *  the fake. Throws synchronously (never rejects — a rejection would be swallowed
 *  by the client's E_CAPABILITY resilience and the drift would stay invisible). */
const assertEnvelopeHonest = (env: SentEnvelope): void => {
  if (!(SENDER_CONTEXTS as readonly string[]).includes(env.senderContext)) {
    throw new Error(
      `fake-transport: senderContext '${env.senderContext}' is not in SENDER_CONTEXTS`,
    );
  }
  const spec = MESSAGE_REGISTRY[env.name];
  if (spec === undefined || spec.availability !== 'v1') {
    if (!INTERNAL_NAMES.has(env.name)) {
      throw new Error(
        `fake-transport: '${env.name}' is neither a v1 registry name nor a served internal name`,
      );
    }
    return; // Tier-2 internal: served by the SW with its own contracts (no registry spec)
  }
  if (spec.kind !== env.kind) {
    throw new Error(
      `fake-transport: '${env.name}' sent as '${env.kind}' but the registry declares '${spec.kind}'`,
    );
  }
  const result = validateObject(
    spec.payload as SchemaSpec,
    env.payload as Record<string, unknown>,
    { message: env.name, field: 'payload' },
    0,
  );
  if (!result.ok) {
    throw new Error(
      `fake-transport: '${env.name}' payload fails the registry spec (${result.error.code})`,
    );
  }
};

/** Ack-side scripting: return the synchronous dispatch response for an envelope. */
export type AckResponder = (env: SentEnvelope) => unknown;

export interface FakeTransport {
  readonly transport: WireTransport;
  readonly sent: SentEnvelope[];
  /** Replace the ack responder (default: {outcome:'ack'}). */
  readonly respondWith: (responder: AckResponder) => void;
  /** Make the NEXT send reject (SW unreachable / listener absence). */
  readonly failNextSend: (reason?: Error) => void;
  /** Make ALL sends reject until released (persistent SW death). */
  readonly failAll: (fail: boolean) => void;
  /** The most recent envelope of a given name (or throw — assert ergonomics). */
  readonly lastOf: (name: string) => SentEnvelope;
  readonly countOf: (name: string) => number;
  /** Broadcast a §3.5 stream message to every attached surface listener. */
  readonly emitStream: (name: string, payload: unknown) => void;
  /** Broadcast anything (malformed-message filtering tests). */
  readonly emitRaw: (raw: unknown) => void;
  /** Ack + terminal in one call — the happy path of the exactly-one law. */
  readonly acknowledge: (cid: string, intentId?: string) => void;
  readonly apply: (cid: string, result?: unknown) => void;
  readonly fail: (cid: string, error: unknown) => void;
  /** How many surface listeners are attached right now (cleanup assertions). */
  readonly listenerCount: () => number;
  readonly reset: () => void;
}

export const createFakeTransport = (): FakeTransport => {
  const sent: SentEnvelope[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let responder: AckResponder = () => ({ outcome: 'ack' });
  let failNext: Error | undefined;
  let failEvery: Error | undefined;

  const emit = (raw: unknown): void => {
    for (const listener of [...listeners]) listener(raw);
  };

  return {
    transport: {
      send: (message) => {
        const env = message as SentEnvelope;
        sent.push(env);
        assertEnvelopeHonest(env);
        if (failNext !== undefined) {
          const reason = failNext;
          failNext = undefined;
          return Promise.reject(reason);
        }
        if (failEvery !== undefined) return Promise.reject(failEvery);
        return Promise.resolve(responder(env));
      },
      listen: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    sent,
    respondWith: (next) => {
      responder = next;
    },
    failNextSend: (reason) => {
      failNext = reason ?? new Error('simulated transport failure');
    },
    failAll: (fail) => {
      failEvery = fail ? new Error('simulated SW death') : undefined;
    },
    lastOf: (name) => {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        const env = sent[i];
        if (env !== undefined && env.name === name) return env;
      }
      throw new Error(`fake-transport: no envelope named ${name} was sent`);
    },
    countOf: (name) => sent.filter((env) => env.name === name).length,
    emitStream: (name, payload) => {
      emit({ v: CONTRACT_V, kind: 'stream', name, payload });
    },
    emitRaw: emit,
    acknowledge: (cid, intentId) => {
      emit({
        v: CONTRACT_V,
        kind: 'stream',
        name: 'CommandAck',
        payload: { cid, ...(intentId !== undefined ? { intentId } : {}) },
      });
    },
    apply: (cid, result) => {
      emit({ v: CONTRACT_V, kind: 'stream', name: 'CommandApplied', payload: { cid, result } });
    },
    fail: (cid, error) => {
      emit({ v: CONTRACT_V, kind: 'stream', name: 'CommandFailed', payload: { cid, error } });
    },
    listenerCount: () => listeners.size,
    reset: () => {
      sent.length = 0;
      responder = () => ({ outcome: 'ack' });
      failNext = undefined;
      failEvery = undefined;
    },
  };
};

/** Deterministic cid entropy: minted ids stay ULID-shaped, tests stay readable. */
export const createTestEntropy = (start = 1_700_000_000_000): CidEntropy => {
  const tick = start;
  let seed = 0x2f;
  return {
    now: () => tick,
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (seed + i * 0x25) & 0xff;
      }
      seed += 1;
      return bytes;
    },
  };
};

/** Flush the microtask queue (surfaces settle acks/terminals off promises). */
export const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

/** A mutable-clock entropy for TTL/expiry tests. */
export const createClockEntropy = (
  start = 1_700_000_000_000,
): {
  readonly entropy: CidEntropy;
  readonly clock: { now: () => number; advance: (byMs: number) => void };
} => {
  let tick = start;
  let seed = 0x5a;
  return {
    entropy: {
      now: () => tick,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) {
          bytes[i] = (seed + i * 0x11) & 0xff;
        }
        seed += 1;
        return bytes;
      },
    },
    clock: {
      now: () => tick,
      advance: (byMs) => {
        tick += byMs;
      },
    },
  };
};
