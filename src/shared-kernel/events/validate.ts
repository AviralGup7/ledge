// E1-T07 · ADR-010 zero-dependency runtime validation, derived from the registry field tables.
// Forward tolerance (ADR-033): unknown extra fields are PRESERVED, never stripped;
// unknown types are not errors (see upcast.ts passthrough).
import { ledgeError } from '../result/error.js';
import { err, ok, type Result } from '../result/result.js';
import { isHlc } from '../clock/hlc.js';
import { isId } from '../identity/id.js';
import type { EventEnvelope } from './envelope.js';
import { EVENT_REGISTRY } from './events.registry.js';

type FieldKind =
  | 'id'
  | 'string'
  | 'number'
  | 'boolean'
  | 'primitive'
  | 'id[]'
  | 'string[]'
  | 'record'
  | 'record[]';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const kindOk = (kind: FieldKind, value: unknown): boolean => {
  switch (kind) {
    case 'id':
      return isId(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'primitive':
      return (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      );
    case 'id[]':
      return Array.isArray(value) && value.every(isId);
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'record':
      return isRecord(value);
    case 'record[]':
      return Array.isArray(value) && value.every(isRecord);
  }
};

export const isKnownEventType = (type: string): boolean => type in EVENT_REGISTRY;

export function validateEnvelope(candidate: unknown): Result<EventEnvelope> {
  if (!isRecord(candidate))
    return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'envelope-not-record' }));
  if (!isId(candidate['eventId']))
    return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'eventId' }));
  if (!isHlc(candidate['hlc'])) return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'hlc' }));
  if (typeof candidate['type'] !== 'string')
    return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'type' }));
  if (candidate['producerContext'] !== 'sw')
    return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'producerContext' }));
  if (!('payload' in candidate)) return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'payload' }));
  return ok(candidate as unknown as EventEnvelope);
}

/**
 * Payload validation against the registry table for a KNOWN type.
 * Extra unknown fields pass through untouched (ADR-033); missing/wrong-typed required fields fail.
 */
export function validatePayload(type: string, payload: unknown): Result<Record<string, unknown>> {
  const spec = EVENT_REGISTRY[type as keyof typeof EVENT_REGISTRY];
  if (spec === undefined) {
    return err(ledgeError('E_FORMAT_UNKNOWN', { type }));
  }
  if (!isRecord(payload))
    return err(ledgeError('E_OUTPUT_MALFORMED', { type, what: 'payload-not-record' }));
  for (const [fieldName, kind] of Object.entries(spec.fields)) {
    const optional = fieldName.endsWith('?');
    const key = optional ? fieldName.slice(0, -1) : fieldName;
    const value = payload[key];
    if (value === undefined) {
      if (!optional) return err(ledgeError('E_OUTPUT_MALFORMED', { type, missing: key }));
      continue;
    }
    if (!kindOk(kind as FieldKind, value)) {
      return err(ledgeError('E_OUTPUT_MALFORMED', { type, badField: key }));
    }
  }
  return ok(payload);
}
