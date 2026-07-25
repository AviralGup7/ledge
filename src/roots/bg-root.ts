// Background composition root (ADR-025 · E1-T12) — the ONLY place background
// application↔infrastructure wiring may live. Construction and activation are split:
//   compose*   — chrome-free graph construction (node-testable; contexts boot with
//                stub adapters per EES §9.16 — tests inject the memory storage
//                adapter and stub entropy through BackgroundGraphDeps).
//   bootstrap* — thin activation: lifecycle listeners register synchronously
//                (MV3 law, ADR-007), then the composed graph is returned.
// No domain logic lands here: hub, ingest and recovery wire against this seam in E2.
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { StoreName } from '@/application/ports/storage-engine.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createDexieStorageEngine, type DexieEngineDeps } from '@/infrastructure/storage/index.js';
import {
  createDeviceId,
  isDeviceId,
  type DeviceId,
  type RandomBytes,
} from '@/shared-kernel/identity/index.js';
import { err, ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

/** meta row carrying install identity (EES §5 meta-row law; stamped exactly once). */
const META_DEVICE_ID_KEY = 'deviceId';

/** Type alias (not interface) so the row stays assignable to StoredRecord. */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

export interface BackgroundGraphDeps {
  /** Test seam: inject a stub adapter (ops contract binding #2, memory engine). */
  readonly storage?: StorageEnginePort;
  /** Production IDB environment seam (fake-indexeddb in non-SW hosts). */
  readonly idb?: DexieEngineDeps;
  /** Entropy seam for identity provisioning; production binds the platform CSPRNG. */
  readonly randomBytes?: RandomBytes;
}

export interface BackgroundBoot {
  /** Install identity, stable across every restart (EES §2.1 immutability law). */
  readonly deviceId: DeviceId;
}

export interface BackgroundGraph {
  readonly storage: StorageEnginePort;
  readonly journal: JournalPort;
  /**
   * Boot completion handle: storage opened + identity provisioned. Fatal boot
   * failures (E_CORRUPT_STORE, E_CAPABILITY_ENTROPY per the EES §2.1 first-run
   * law) surface here as err — never as throws, never as a half-booted graph.
   */
  readonly boot: Promise<Result<BackgroundBoot, LedgeError>>;
}

const BOOT_SCOPE: readonly StoreName[] = ['meta'];

/** Open storage, then install-identity read-through (get-or-create) in ONE txn. */
const bootIdentity = async (
  storage: StorageEnginePort,
  randomBytes?: RandomBytes,
): Promise<Result<BackgroundBoot, LedgeError>> => {
  const opened = await storage.open();
  if (!opened.ok) return opened;
  return storage.txn(BOOT_SCOPE, 'readwrite', async (tx) => {
    const meta = tx.table<MetaRow>('meta');
    const existing = await meta.get(META_DEVICE_ID_KEY);
    if (existing !== undefined) {
      // Immutability law: a stamped deviceId is never re-derived. A malformed row is a
      // store-integrity failure (rescue path) — re-minting silently would fork identity.
      if (!isDeviceId(existing.value)) {
        throw ledgeError('E_CORRUPT_STORE', { what: 'deviceId-row', field: 'value' });
      }
      return { deviceId: existing.value };
    }
    // First run: mint once. Entropy failure is fatal (EES §2.1): without a
    // collision-safe identity no durable state may exist, so boot halts here.
    let deviceId: DeviceId;
    try {
      deviceId = createDeviceId(randomBytes);
    } catch {
      throw ledgeError('E_CAPABILITY_ENTROPY', { op: 'provision-device-id' });
    }
    await meta.put({ key: META_DEVICE_ID_KEY, value: deviceId });
    return { deviceId };
  });
};

export function composeBackgroundGraph(deps: BackgroundGraphDeps = {}): BackgroundGraph {
  const storage = deps.storage ?? createDexieStorageEngine(deps.idb);
  const journal = createJournal(storage);
  // An adapter that throws instead of returning err is an integrity event at boot —
  // fold it into the fatal class so callers only ever reason about Results.
  const boot = bootIdentity(storage, deps.randomBytes).catch((cause: unknown) =>
    err(ledgeError('E_CORRUPT_STORE', { what: 'boot-unexpected-throw', cause: String(cause) })),
  );
  return { storage, journal, boot };
}

/**
 * Activate the background context. Listeners register first and synchronously
 * (ADR-007); the async boot proceeds behind them and its Result is retained on
 * the returned graph — E2's boot reconciler takes ownership of it from here.
 */
export function bootstrapBackground(): BackgroundGraph {
  chrome.runtime.onInstalled.addListener((details) => {
    // First-run marker (E4-T11 owns onboarding; recovery marker semantics land E2-T07).
    // Record the install reason so update-vs-crash disambiguation (EES §10-R16) has input.
    void chrome.storage.local.set({
      'meta.buildMarker': { reason: details.reason, at: Date.now() },
    });
  });
  return composeBackgroundGraph();
}
