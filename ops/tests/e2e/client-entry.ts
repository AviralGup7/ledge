// E6-T01 · real-restart e2e lane — page-side wire client for the browser harness.
// Bundled by `pnpm build:e2e-client` into ops/tests/e2e/client.js (a gitignored
// build artifact) and injected into extension-context pages by
// ops/tests/e2e/recovery-w7.e2e.test.ts.
//
// It reuses the REAL surface wire client (createWireClient + cid minter), so the
// harness speaks exactly the frozen §3.1 envelope dialect a production surface
// speaks — same two-phase ack/terminal law, same stream subscription. The only
// additions are harness verbs:
//
//   sendCommand/sendQuery — ack + terminal delivered as one awaited round trip
//   seed                  — direct IDB precondition row puts (intents / tabs /
//                           missions stores); the ONLY authority the harness
//                           holds, used to plant the crash-side world (pending
//                           intents, live scope rows) that a REAL browser kill
//                           then forces the product's own boot act to act on
//   streamLog             — every §3.5 stream seen since injection (assert aid)
//   mintCid               — ULID-shaped ids for precondition rows
//
// Seeding is a test precondition write, never product behaviour: once the rows
// land, the browser is really SIGKILLed and every following move (classify,
// reconcile, slot, card gating, put-back) is made by the product alone.
import {
  createWireClient,
  type AckOutcome,
  type TerminalOutcome,
  type WireClient,
  type WireTransport,
} from '@/surfaces/components/session/client.js';
import { createCidMinter } from '@/surfaces/components/session/ids.js';

/** Precondition rows the harness plants into the extension's real IndexedDB. */
export interface SeedSpec {
  readonly dbName: string;
  readonly intents: readonly Record<string, unknown>[];
  readonly tabs: readonly Record<string, unknown>[];
  readonly missions: readonly Record<string, unknown>[];
}

/** One send's full two-phase story (envelope ack + dispatcher terminal). */
export interface RoundTrip {
  readonly ack: AckOutcome;
  readonly terminal: TerminalOutcome;
}

export interface LedgeE2EClient {
  readonly mintCid: () => string;
  readonly streamLog: { name: string; payload: unknown }[];
  readonly sendCommand: (name: string, payload: unknown) => Promise<RoundTrip>;
  readonly sendQuery: (name: string, payload: unknown) => Promise<RoundTrip>;
  readonly seed: (spec: SeedSpec) => Promise<string>;
}

declare global {
  interface Window {
    __ledgeE2E?: LedgeE2EClient;
  }
}

const entropy = {
  now: () => Date.now(),
  randomBytes: (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length)),
};

// The production transport shape (promise-form sendMessage; lastError rides the
// rejection — the client folds it into the 'unreachable' ack class, exactly how
// a surface witnesses a dying SW).
const transport: WireTransport = {
  send: (message) => chrome.runtime.sendMessage(message),
  listen: (listener) => {
    const handler = (raw: unknown): void => {
      listener(raw);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
    };
  },
};

const client: WireClient = createWireClient({ context: 'quiet', transport, entropy });
const streamLog: { name: string; payload: unknown }[] = [];
client.subscribe({
  onAny: (name, payload) => {
    streamLog.push({ name, payload });
  },
});

const roundTrip = async (handle: {
  ack: Promise<AckOutcome>;
  terminal: Promise<TerminalOutcome>;
}): Promise<RoundTrip> => ({ ack: await handle.ack, terminal: await handle.terminal });

const seed = (spec: SeedSpec): Promise<string> =>
  new Promise<string>((resolveSeed, rejectSeed) => {
    const openRequest = indexedDB.open(spec.dbName);
    openRequest.onerror = () => rejectSeed(new Error(`idb-open:${String(openRequest.error)}`));
    openRequest.onblocked = () => rejectSeed(new Error('idb-open:blocked'));
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const tx = db.transaction(['intents', 'tabs', 'missions'], 'readwrite');
      for (const row of spec.intents) tx.objectStore('intents').put(row);
      for (const row of spec.tabs) tx.objectStore('tabs').put(row);
      for (const row of spec.missions) tx.objectStore('missions').put(row);
      tx.oncomplete = () => {
        db.close();
        resolveSeed(
          `seeded intents=${spec.intents.length} tabs=${spec.tabs.length} missions=${spec.missions.length}`,
        );
      };
      tx.onerror = () => {
        db.close();
        rejectSeed(new Error(`idb-txn:${String(tx.error)}`));
      };
      tx.onabort = () => {
        db.close();
        rejectSeed(new Error(`idb-txn-abort:${String(tx.error)}`));
      };
    };
  });

window.__ledgeE2E = {
  mintCid: createCidMinter(entropy),
  streamLog,
  sendCommand: (name, payload) => roundTrip(client.command(name, payload)),
  sendQuery: (name, payload) => roundTrip(client.query(name, payload)),
  seed,
};
