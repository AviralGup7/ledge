// E1-T08 · EES §3.2 uniform error envelope.
// {code, retryable, messageKey, recoveryKey, details?, watermarkHint?}
// Payloads never carry display copy — surfaces resolve keys against the copy catalog.
import type { ErrorCode } from './error-codes.catalog.js';
import { ERROR_MAP } from './error.catalog.js';

export type ErrorPrimitive = string | number | boolean | null;
export type ErrorDetails = Readonly<Record<string, ErrorPrimitive>>;

export interface LedgeError {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly messageKey: string;
  readonly recoveryKey: string;
  readonly details?: ErrorDetails | undefined;
  readonly watermarkHint?: number | undefined;
}

const isPrimitive = (v: unknown): v is ErrorPrimitive =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Construct the uniform error envelope for a known code.
 * `details` is programmer-facing context (never rendered): primitives only, per §3.2.
 * Throws TypeError on non-primitive details — that is a caller bug, not a runtime failure mode.
 */
export function ledgeError(
  code: ErrorCode,
  details?: ErrorDetails,
  watermarkHint?: number,
): LedgeError {
  const mapped = ERROR_MAP[code];
  if (details !== undefined) {
    for (const [k, v] of Object.entries(details)) {
      if (!isPrimitive(v))
        throw new TypeError(
          `LedgeError details must be primitives only; got ${typeof v} at "${k}"`,
        );
    }
  }
  const base: LedgeError = {
    code,
    retryable: mapped.retryable,
    messageKey: mapped.messageKey,
    recoveryKey: mapped.recoveryKey,
  };
  return {
    ...base,
    ...(details !== undefined ? { details } : {}),
    ...(watermarkHint !== undefined ? { watermarkHint } : {}),
  };
}
