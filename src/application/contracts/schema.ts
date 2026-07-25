// E1-T11 · ADR-010/ADR-037 — hand-rolled payload schema validator (zero-dependency law).
// The DSL is deliberately tiny: it must express every §3.3–3.7 payload contract and
// nothing more. Field kinds: 'string' | 'number' | 'int' | 'boolean' | 'id' | 'primitive'
// | {enum} | {array} | {object} | {oneOf}. Optional fields are keys suffixed '?'
// (mirrors the §3 and §4 registry convention).
//
// EES §3.1 rule (c): unknown fields inside payloads are tolerated on read and stripped
// on re-emit. `validatePayload` therefore returns BOTH outcomes in one pass:
// `normalized` is the stripped form (safe to re-emit/persist) while validation itself
// accepts the wider input.
import { isId } from '@/shared-kernel/identity/id.js';
import { ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { err, ok } from '@/shared-kernel/result/index.js';

export type FieldSpec =
  | 'string'
  | 'number'
  | 'int'
  | 'boolean'
  | 'id'
  | 'primitive'
  | 'unknown'
  | { readonly enum: readonly string[] }
  | { readonly text: { readonly maxLength: number } } // §3 length laws (name≤120, q≤200, note≤2000)
  | { readonly literal: string | number | boolean | null } // §3 exact-confirm payloads (confirm:true)
  | { readonly array: FieldSpec; readonly maxItems?: number }
  | { readonly object: SchemaSpec }
  | { readonly oneOf: readonly FieldSpec[] };

export type SchemaSpec = Readonly<Record<string, FieldSpec>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPrimitive = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const malformed = (name: string, field: string, rule: string): LedgeError =>
  ledgeError('E_OUTPUT_MALFORMED', { message: name, field, rule });

/** Structural field check (kind-level, depth-bounded by the envelope laws). */
export function checkField(
  spec: FieldSpec,
  value: unknown,
  ctx: { readonly message: string; readonly field: string },
  depth: number,
): Result<true, LedgeError> {
  if (spec === 'string')
    return typeof value === 'string' ? ok(true) : err(malformed(ctx.message, ctx.field, 'string'));
  if (spec === 'number')
    return typeof value === 'number' && Number.isFinite(value)
      ? ok(true)
      : err(malformed(ctx.message, ctx.field, 'number'));
  if (spec === 'int')
    return Number.isSafeInteger(value) ? ok(true) : err(malformed(ctx.message, ctx.field, 'int'));
  if (spec === 'boolean')
    return typeof value === 'boolean'
      ? ok(true)
      : err(malformed(ctx.message, ctx.field, 'boolean'));
  if (spec === 'id') return isId(value) ? ok(true) : err(malformed(ctx.message, ctx.field, 'id'));
  if (spec === 'primitive')
    return isPrimitive(value) ? ok(true) : err(malformed(ctx.message, ctx.field, 'primitive'));
  if (spec === 'unknown') return ok(true); // escape hatch: documented unknowns (opaque refs)
  if ('enum' in spec) {
    return typeof value === 'string' && spec.enum.includes(value)
      ? ok(true)
      : err(malformed(ctx.message, ctx.field, `enum:${spec.enum.join('|')}`));
  }
  if ('text' in spec) {
    return typeof value === 'string' && value.length <= spec.text.maxLength
      ? ok(true)
      : err(malformed(ctx.message, ctx.field, `maxLength:${spec.text.maxLength}`));
  }
  if ('literal' in spec) {
    return value === spec.literal
      ? ok(true)
      : err(malformed(ctx.message, ctx.field, `literal:${String(spec.literal)}`));
  }
  if ('array' in spec) {
    if (!Array.isArray(value)) return err(malformed(ctx.message, ctx.field, 'array'));
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      return err(malformed(ctx.message, ctx.field, `maxItems:${spec.maxItems}`));
    }
    for (let i = 0; i < value.length; i++) {
      const r = checkField(
        spec.array,
        value[i],
        { ...ctx, field: `${ctx.field}[${i}]` },
        depth + 1,
      );
      if (!r.ok) return r;
    }
    return ok(true);
  }
  if ('object' in spec) {
    if (!isRecord(value)) return err(malformed(ctx.message, ctx.field, 'object'));
    const r = validateObject(spec.object, value, ctx, depth + 1);
    return r.ok ? ok(true) : r;
  }
  // oneOf
  for (const alt of spec.oneOf) {
    if (checkField(alt, value, ctx, depth + 1).ok) return ok(true);
  }
  return err(malformed(ctx.message, ctx.field, 'oneOf'));
}

/** Validate a whole payload object against the spec; also yields the stripped re-emit form. */
export function validateObject(
  spec: SchemaSpec,
  payload: Record<string, unknown>,
  ctx: { readonly message: string; readonly field: string },
  depth: number,
): Result<{ normalized: Record<string, unknown> }, LedgeError> {
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, fieldSpec] of Object.entries(spec)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    const value = payload[key];
    if (value === undefined) {
      if (!optional) return err(malformed(ctx.message, key, 'required'));
      continue;
    }
    const r = checkField(fieldSpec, value, { ...ctx, field: key }, depth);
    if (!r.ok) return r;
    normalized[key] = value;
  }
  return ok({ normalized });
}

/** Parse a payload spec back into {required, optional} key sets — registry self-audit. */
export const specKeys = (spec: SchemaSpec): { required: string[]; optional: string[] } => {
  const required: string[] = [];
  const optional: string[] = [];
  for (const rawKey of Object.keys(spec)) {
    if (rawKey.endsWith('?')) optional.push(rawKey.slice(0, -1));
    else required.push(rawKey);
  }
  return { required, optional };
};
