// E1-T07 · EES §4 envelope — common fields every event carries.
// {eventId, hlc, type@1, payload, producerContext, idempotencyKey?}
import type { Hlc } from '../clock/hlc.js';
import type { Id } from '../identity/id.js';

export interface EventEnvelope<TName extends string = string, TPayload = unknown> {
  readonly eventId: Id;
  readonly hlc: Hlc;
  /** Registered type name, schema-suffixed in contract (types are declared @1 in EVENT_REGISTRY). */
  readonly type: TName;
  readonly payload: TPayload;
  /** Always 'sw' in v1 — the single-writer service worker context (ADR-005). */
  readonly producerContext: 'sw';
  /** When present, application is idempotent by this key (prevents double-apply on retry). */
  readonly idempotencyKey?: string | undefined;
}

/** Stored form on the journal: explicit format version + envelope (ADR-033 registry (1)). */
export interface StoredEvent<TName extends string = string, TPayload = unknown> {
  readonly v: number;
  readonly event: EventEnvelope<TName, TPayload>;
}
