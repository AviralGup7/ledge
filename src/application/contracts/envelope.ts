// E1-T11 · EES §3.1 wire envelope — the one shape crossing every context boundary (ADR-010).
// {v, kind, name, cid, senderContext, payload, contractHash}. Type declaration here is the
// wire truth; structural validation lives in validate.ts (validators run before dispatch,
// §3.1 rule a).
import type { Id } from '@/shared-kernel/identity/id.js';
import type { WireKind } from './message.registry.js';

/** Contract version on the wire. Dual-read window law (ADR-010): a v-bump ships readers
 *  for {v, v-1} simultaneously; CONTRACT_V marks this build's production version. */
export const CONTRACT_V = 1;

/** EES §3.1 rule (d): payload hard cap 256KB — larger goes through a streaming contract. */
const KIB = 1024;
const PAYLOAD_MAX_KIB = 256;
export const PAYLOAD_MAX_BYTES = PAYLOAD_MAX_KIB * KIB;
/** EES §3.1 rule (e): arrays capped at 10k items — larger goes through a stream. */
export const ARRAY_MAX_ITEMS = 10_000;
/** Validator totality bound: hostile/degenerate nesting never throws or overflows. */
export const DEPTH_MAX = 32;

export const SENDER_CONTEXTS = ['guardian', 'overlay', 'quiet', 'offscreen', 'sw'] as const;
export type SenderContext = (typeof SENDER_CONTEXTS)[number];

/**
 * Trust zones per Blueprint §1/§2 (ADR-040): zone0 = bundled privileged core (SW,
 * offscreen doc, extension pages); zone1 = future consented content scripts. Zone is
 * DERIVED from the channel by the boundary adapter, never claimed by the sender.
 */
export type MessageZone = 'zone0' | 'zone1';

export interface MessageEnvelope<TPayload = unknown> {
  readonly v: number;
  readonly kind: WireKind;
  readonly name: string;
  /** Correlation/client op id (ULID) — dedupe anchor per §3.3 timeout law. */
  readonly cid: Id;
  readonly senderContext: SenderContext;
  readonly payload: TPayload;
  /** Schema-registry hash at build (contract-hash.ts); agreement checked at handshake. */
  readonly contractHash: string;
}
