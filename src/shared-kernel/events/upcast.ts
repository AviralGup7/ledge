// E1-T07 · ADR-033 registry (1) — upcaster chain skeleton.
// Laws: stored events are never mutated; upcasters are pure and total per version pair;
// unknown type OR unknown/future version ⇒ PRESERVE-passthrough (forward tolerance,
// projection skips it, replay keeps it); a registered chain with a missing step is a
// registry integrity bug and reports E_SCHEMA_UPCAST_GAP — never a silent drop.
import { ledgeError } from '../result/error.js';
import { err, ok, type Result } from '../result/result.js';
import type { EventEnvelope, StoredEvent } from './envelope.js';
import { EVENT_REGISTRY } from './events.registry.js';
import { isKnownEventType, validateEnvelope, validatePayload } from './validate.js';

/** A v(n) → v(n+1) pure payload transform for one type. */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

// v1 registry: no prior versions exist, so the chain is empty by construction.
// When schemaV reaches 2, populate UPCASTERS['Type@1'] and auditUpcastChain() enforces contiguity.
const UPCASTERS: Readonly<Record<string, Upcaster>> = {};

export const CURRENT_SCHEMA_VERSION = 1;

export type UpcastOutcome =
  | { readonly status: 'current'; readonly event: EventEnvelope }
  | { readonly status: 'upcasted'; readonly event: EventEnvelope }
  | {
      readonly status: 'preserved-unknown';
      readonly raw: StoredEvent;
      readonly reason: 'type' | 'version';
    };

export function upcastEvent(stored: StoredEvent): Result<UpcastOutcome> {
  const envelope = validateEnvelope(stored.event);
  if (!envelope.ok) return envelope;
  const type = stored.event.type;

  if (!isKnownEventType(type))
    return ok({ status: 'preserved-unknown', raw: stored, reason: 'type' });

  const registered = EVENT_REGISTRY[type as keyof typeof EVENT_REGISTRY];
  if (stored.v === CURRENT_SCHEMA_VERSION && registered.schemaV === CURRENT_SCHEMA_VERSION) {
    const payload = validatePayload(type, stored.event.payload);
    if (!payload.ok) return payload;
    return ok({ status: 'current', event: stored.event });
  }
  if (stored.v > CURRENT_SCHEMA_VERSION || stored.v > registered.schemaV) {
    // From the future (newer build wrote it): preserve, do not project (ADR-033 skew window).
    return ok({ status: 'preserved-unknown', raw: stored, reason: 'version' });
  }

  // v(n) → v(current) via the registered chain.
  let payload = stored.event.payload as Record<string, unknown>;
  let version = stored.v;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = UPCASTERS[`${type}@${version}`];
    if (step === undefined) {
      return err(
        ledgeError('E_SCHEMA_UPCAST_GAP', { type, from: version, to: version + 1 }, undefined),
      );
    }
    payload = step(payload);
    version += 1;
  }
  const validated = validatePayload(type, payload);
  if (!validated.ok) return validated;
  return ok({ status: 'upcasted', event: { ...stored.event, payload } });
}

/**
 * Registry self-audit [registry fixture proof]: every type whose schemaV exceeds 1 must have a
 * contiguous upcaster chain 1→…→schemaV. v1 registry trivially has zero gaps; the audit exists
 * so the first v2 type cannot silently ship a broken chain.
 */
export function auditUpcastChain(): Result<readonly string[]> {
  const gaps: string[] = [];
  for (const [type, spec] of Object.entries(EVENT_REGISTRY)) {
    for (let v = 1; v < spec.schemaV; v++) {
      if (UPCASTERS[`${type}@${v}`] === undefined) gaps.push(`${type}@${v}→${v + 1}`);
    }
  }
  if (gaps.length > 0) return err(ledgeError('E_SCHEMA_UPCAST_GAP', { types: gaps.join(',') }));
  return ok(gaps);
}
