// Public surface of shared-kernel/events (E1-T07 · EES §4 / EES §2.4).
export { EVENT_REGISTRY } from './events.registry.js';
export type { EventTypeName } from './events.registry.js';
export type { EventEnvelope, StoredEvent } from './envelope.js';
export { isKnownEventType, validateEnvelope, validatePayload } from './validate.js';
export type { UpcastOutcome, Upcaster } from './upcast.js';
export { CURRENT_SCHEMA_VERSION, auditUpcastChain, upcastEvent } from './upcast.js';
