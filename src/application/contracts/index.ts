// Public surface of application/contracts (E1-T11 · EES §3, ADR-010/037).
export {
  ARRAY_MAX_ITEMS,
  CONTRACT_V,
  DEPTH_MAX,
  PAYLOAD_MAX_BYTES,
  SENDER_CONTEXTS,
} from './envelope.js';
export type { MessageEnvelope, MessageZone, SenderContext } from './envelope.js';
export { MESSAGE_REGISTRY, ZONE1_ALLOWLIST } from './message.registry.js';
export type { Availability, MessageFamily, MessageSpec, WireKind } from './message.registry.js';
export { validateMessage } from './validate.js';
export type { ValidatedMessage, ValidationOutcome } from './validate.js';
export { checkHello, makeHello } from './handshake.js';
export type { HandshakeOutcome, Hello } from './handshake.js';
export { computeContractHash, contractHashOf } from './contract-hash.js';
export { validateObject, checkField, specKeys } from './schema.js';
export type { FieldSpec, SchemaSpec } from './schema.js';
