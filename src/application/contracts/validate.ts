// E1-T11 · EES §3.1 boundary validators — total functions, never throw (law b + §8 fuzz law).
// run before dispatch (rule a). Outcomes are explicit and exhaustive:
//   ok       — envelope + payload validated; `message.payload` is the normalized
//              (unknown-fields-stripped) form for re-emit per rule (c)
//   ignored  — unknown `name` (forward compat, rule b) or a name whose availability
//              tier this build does not serve; the `ignored` record IS the log line
//              (rule b's "+ log" — the dispatcher hands it to diagnostics verbatim)
//   rejected — malformed envelope, capped laws exceeded, zone violation, wrong version;
//              always carries a typed LedgeError (ADR-026), never an exception
import { isId } from '@/shared-kernel/identity/id.js';
import { ledgeError, type LedgeError } from '@/shared-kernel/result/index.js';
import {
  ARRAY_MAX_ITEMS,
  CONTRACT_V,
  DEPTH_MAX,
  PAYLOAD_MAX_BYTES,
  SENDER_CONTEXTS,
  type MessageEnvelope,
  type MessageZone,
  type SenderContext,
} from './envelope.js';
import {
  MESSAGE_REGISTRY,
  ZONE1_ALLOWLIST,
  type MessageSpec,
  type WireKind,
} from './message.registry.js';
import { validateObject } from './schema.js';

const WIRE_KINDS: readonly WireKind[] = ['command', 'query', 'event', 'stream'];

export interface ValidatedMessage {
  readonly v: number;
  readonly kind: WireKind;
  readonly family: MessageSpec['family'];
  readonly availability: MessageSpec['availability'];
  readonly name: string;
  readonly cid: MessageEnvelope['cid'];
  readonly senderContext: SenderContext;
  /** Normalized payload (§3.1 c: tolerated extras stripped) — safe to re-emit. */
  readonly payload: Record<string, unknown>;
  readonly spec: MessageSpec;
}

export type ValidationOutcome =
  | { readonly type: 'ok'; readonly message: ValidatedMessage }
  | {
      readonly type: 'ignored';
      readonly reason: 'unknown-name' | 'unavailable-name';
      readonly name: string;
      readonly availability?: MessageSpec['availability'] | undefined;
    }
  | { readonly type: 'rejected'; readonly error: LedgeError };

const malformed = (what: string, field?: string): LedgeError =>
  ledgeError('E_OUTPUT_MALFORMED', { what, ...(field !== undefined ? { field } : {}) });

/** §3.1(d)+(e) + totality: size/cap/depth scan with cycle guard, never throws. */
function checkPayloadGuards(payload: unknown): LedgeError | null {
  let byteLength: number | null = null;
  try {
    const s = JSON.stringify(payload);
    byteLength = typeof s === 'string' ? s.length : 0;
  } catch {
    byteLength = null; // circular: structured-clone may carry it; byte cap unmeasurable
  }
  if (byteLength !== null && byteLength > PAYLOAD_MAX_BYTES) {
    return ledgeError('E_OUTPUT_MALFORMED', {
      what: 'payload-over-256kb',
      bytes: byteLength,
      cap: PAYLOAD_MAX_BYTES,
    });
  }
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): LedgeError | null => {
    if (depth > DEPTH_MAX) return malformed('payload-depth-over-32');
    if (typeof value !== 'object' || value === null) return null;
    if (seen.has(value)) return null; // cycle: already scanned
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > ARRAY_MAX_ITEMS) {
        return ledgeError('E_OUTPUT_MALFORMED', {
          what: 'array-over-10k',
          length: value.length,
          cap: ARRAY_MAX_ITEMS,
        });
      }
      for (const item of value) {
        const r = walk(item, depth + 1);
        if (r !== null) return r;
      }
      return null;
    }
    for (const v of Object.values(value)) {
      const r = walk(v, depth + 1);
      if (r !== null) return r;
    }
    return null;
  };
  return walk(payload, 0);
}

export function validateMessage(
  raw: unknown,
  opts: { readonly zone: MessageZone },
): ValidationOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { type: 'rejected', error: malformed('envelope-not-record') };
  }
  const e = raw as Record<string, unknown>;

  // Contract version — frozen dual-read window law (ADR-010). v from the future/past is
  // not "unknown input" to ignore; it is a version skew the handshake escalates.
  if (e['v'] !== CONTRACT_V) {
    return {
      type: 'rejected',
      error: ledgeError('E_FORMAT_UNKNOWN', { what: 'contract-v', v: String(e['v']) }),
    };
  }
  const kind = e['kind'];
  if (typeof kind !== 'string' || !WIRE_KINDS.includes(kind as WireKind)) {
    return { type: 'rejected', error: malformed('kind', String(kind)) };
  }
  const name = e['name'];
  if (typeof name !== 'string') {
    return { type: 'rejected', error: malformed('name') };
  }

  // §3.1(b): unknown name ⇒ ignore (forward compat), never throw.
  const spec = MESSAGE_REGISTRY[name];
  if (spec === undefined) return { type: 'ignored', reason: 'unknown-name', name };

  // Availability tier: v1.1 / v2-boundary names exist in the contract but this build
  // does not serve them — ignore with a distinct reason (not confusion with unknowns).
  if (spec.availability !== 'v1') {
    return { type: 'ignored', reason: 'unavailable-name', name, availability: spec.availability };
  }

  // §3.1(f) Zone-1 law: consented page contexts speak the narrow schema only.
  if (opts.zone === 'zone1' && !ZONE1_ALLOWLIST.includes(name)) {
    return {
      type: 'rejected',
      error: ledgeError('E_CAPABILITY', { zone: 'zone1', name, what: 'not-allowlisted' }),
    };
  }

  // Wire kind must agree with the registry row (a sender lying about kind is malformed).
  if (spec.kind !== kind) {
    return { type: 'rejected', error: malformed('kind-mismatch-with-registry', name) };
  }
  if (!isId(e['cid'])) return { type: 'rejected', error: malformed('cid') };
  const senderContext = e['senderContext'];
  if (
    typeof senderContext !== 'string' ||
    !(SENDER_CONTEXTS as readonly string[]).includes(senderContext)
  ) {
    return { type: 'rejected', error: malformed('senderContext') };
  }
  if (typeof e['contractHash'] !== 'string' || e['contractHash'].length === 0) {
    return { type: 'rejected', error: malformed('contractHash') };
  }
  if (!('payload' in e)) return { type: 'rejected', error: malformed('payload-missing') };

  const guard = checkPayloadGuards(e['payload']);
  if (guard !== null) return { type: 'rejected', error: guard };

  const payloadObj =
    e['payload'] === null || typeof e['payload'] !== 'object' || Array.isArray(e['payload'])
      ? null
      : (e['payload'] as Record<string, unknown>);
  // Payloads are objects by §3 shape (`–` payloads are {}). Non-object payloads rejected.
  if (payloadObj === null) return { type: 'rejected', error: malformed('payload-not-object') };

  const checked = validateObject(spec.payload, payloadObj, { message: name, field: '$' }, 0);
  if (!checked.ok) return { type: 'rejected', error: checked.error };

  return {
    type: 'ok',
    message: {
      v: CONTRACT_V,
      kind,
      family: spec.family,
      availability: spec.availability,
      name,
      cid: e['cid'] as MessageEnvelope['cid'],
      senderContext: senderContext as SenderContext,
      payload: checked.value.normalized,
      spec,
    },
  };
}
