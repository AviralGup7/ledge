// Public surface of shared-kernel/result.
export type { ErrorCode } from './error-codes.catalog.js';
export { ERROR_CODES } from './error-codes.catalog.js';
export { ERROR_MAP } from './error.catalog.js';
export type { LedgeError, ErrorDetails, ErrorPrimitive } from './error.js';
export { ledgeError } from './error.js';
export type { Result } from './result.js';
export { ok, err, isOk, isErr, map, flatMap, unwrapOr } from './result.js';
