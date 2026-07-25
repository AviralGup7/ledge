// E3-APP · dispatch barrel — the one import path for the command/query plane.
export { createDispatcher } from './dispatcher.js';
export type { Dispatcher, DispatcherDeps } from './dispatcher.js';
export { createHandlerRegistry, commandOf, queryOf } from './registry.js';
export type { HandlerRegistry, CommandRegistration, QueryRegistration } from './registry.js';
export type { DispatchAnswer, Handler, HandlerCtx, Lane, TerminalRecord } from './types.js';
export { createAppEventBus } from './app-events.js';
export type { AppEvent, AppEventBus, AppEventListener } from './app-events.js';
export { createCancellationRegistry, isCancelledMarker } from './cancellation.js';
export type { CancelToken, CancellationRegistry } from './cancellation.js';
export { createCidDedupeCache } from './cid-dedupe.js';
export type { CidDedupeCache } from './cid-dedupe.js';
export type { ProgressEvent, ProgressEmitter } from './progress.js';
export type { CommandLogEntry, StructuredLogSink } from './log.js';
export { createRingLogSink, fanOutSinks } from './log.js';
