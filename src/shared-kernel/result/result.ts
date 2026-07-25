// E1-T08 · ADR-026 — uniform Result. Never throw across boundaries; return this.
import type { LedgeError } from './error.js';

export type Result<T, E extends LedgeError = LedgeError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends LedgeError>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E extends LedgeError>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E extends LedgeError>(r: Result<T, E>): r is { ok: false; error: E } =>
  !r.ok;

export const map = <T, U, E extends LedgeError>(r: Result<T, E>, f: (v: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const flatMap = <T, U, E extends LedgeError>(
  r: Result<T, E>,
  f: (v: T) => Result<U, E>,
): Result<U, E> => (r.ok ? f(r.value) : r);

/** Unwrap with fallback — surfaces use this; they must never branch on thrown exceptions. */
export const unwrapOr = <T, E extends LedgeError>(r: Result<T, E>, fallback: T): T =>
  r.ok ? r.value : fallback;
