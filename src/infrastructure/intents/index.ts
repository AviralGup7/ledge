// Public surface of infrastructure/intents (ADR-011 two-phase durability, E2-T02).
// Part of the durable-write family: may compose journal + storage (writer-concentration).
export { createIntentLedger } from './ledger.js';
export type { IntentLedgerDeps } from './ledger.js';
