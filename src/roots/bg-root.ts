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
import { createChromeStorageAreaAdapter } from '@/infrastructure/chrome/index.js';
import { stampInstallMarker } from '@/infrastructure/recovery/marker/index.js';
import { createDexieStorageEngine, type DexieEngineDeps } from '@/infrastructure/storage/index.js';
import {
  createDeviceId,
  isDeviceId,
  type DeviceId,
  type RandomBytes,
} from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

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

/**
 * EES §5 global law 6 — boot-time storage health. Probed on every boot (cold
 * or warm): quota posture + durable persistence. The persistence REQUEST runs
 * whenever the bucket isn't persisted yet (first-run is a special case of
 * that condition; navigator.storage.persist() is idempotent and silent in
 * Chrome, so re-asking costs nothing and the law needs no first-run memory).
 * Failures here are telemetry, not boot blockers: quota/persist misbehaviour
 * degrades to explicit report fields, never to a fatal boot error.
 */
export interface StorageLawReport {
  readonly apiAvailable: boolean;
  readonly persisted: boolean;
  /** True when persist() was invoked this boot (only when not already persisted). */
  readonly requested: boolean;
  /** Outcome: already-persisted, or the persist() answer when requested. */
  readonly granted: boolean;
  /** usage/quota in [0,1] when the platform discloses both; §5's <80% posture. */
  readonly pressureRatio?: number | undefined;
  /** Error code when probing/requesting failed (non-fatal by law). */
  readonly error?: string | undefined;
}

export interface BackgroundBoot {
  /** Install identity, stable across every restart (EES §2.1 immutability law). */
  readonly deviceId: DeviceId;
  readonly storageLaw: StorageLawReport;
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
): Promise<Result<{ readonly deviceId: DeviceId }, LedgeError>> => {
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

/** §5 law 6 wiring: probe quota, request persistence when the bucket isn't durable. */
const bootStorageLaw = async (storage: StorageEnginePort): Promise<StorageLawReport> => {
  try {
    const probed = await storage.quota();
    if (!probed.ok) {
      return {
        apiAvailable: false,
        persisted: false,
        requested: false,
        granted: false,
        error: probed.error.code,
      };
    }
    const quota = probed.value;
    const base = {
      apiAvailable: quota.apiAvailable,
      persisted: quota.persisted,
      ...(quota.pressureRatio !== undefined ? { pressureRatio: quota.pressureRatio } : {}),
    };
    if (!quota.apiAvailable || quota.persisted) {
      return { ...base, requested: false, granted: quota.persisted };
    }
    const answer = await storage.persist();
    if (!answer.ok) {
      return { ...base, requested: true, granted: false, error: answer.error.code };
    }
    return { ...base, requested: true, granted: answer.value };
  } catch (cause) {
    // A misbehaving probe/persist adapter is a health-signal gap, not a boot blocker.
    return {
      apiAvailable: false,
      persisted: false,
      requested: false,
      granted: false,
      error: ledgeError('E_CAPABILITY', { site: 'boot-storage-law', raw: String(cause) }).code,
    };
  }
};

export function composeBackgroundGraph(deps: BackgroundGraphDeps = {}): BackgroundGraph {
  const storage = deps.storage ?? createDexieStorageEngine(deps.idb);
  const journal = createJournal(storage);
  // An adapter that throws instead of returning err is an integrity event at boot —
  // fold it into the fatal class so callers only ever reason about Results.
  const boot = bootIdentity(storage, deps.randomBytes)
    .then(async (identity): Promise<Result<BackgroundBoot, LedgeError>> => {
      if (!identity.ok) return err(identity.error);
      const storageLaw = await bootStorageLaw(storage);
      return ok({ deviceId: identity.value.deviceId, storageLaw });
    })
    .catch((cause: unknown) =>
      err(ledgeError('E_CORRUPT_STORE', { what: 'boot-unexpected-throw', cause: String(cause) })),
    );
  return { storage, journal, boot };
}

/**
 * Activate the background context. Listeners register first and synchronously
 * (ADR-007); the async boot proceeds behind them and its Result is retained on
 * the returned graph. The onInstalled listener stamps the version-change
 * marker (EES-R16 disambiguator input) through the StorageAreaPort adapter —
 * the rest of the crash-marker lifecycle + boot reconcile (runBootSequence)
 * wires here when the recovery graph lands (ledger/projections composition).
 */
export function bootstrapBackground(): BackgroundGraph {
  const storageArea = createChromeStorageAreaAdapter();
  chrome.runtime.onInstalled.addListener((details) => {
    // E2-T07 · EES-R16: every install/update/chrome_update leaves a durable
    // version stamp; the boot classifier compares it against the last
    // completed boot to separate update-driven restarts from crashes.
    void stampInstallMarker(
      storageArea,
      {
        reason: details.reason,
        ...(details.previousVersion !== undefined
          ? { previousVersion: details.previousVersion }
          : {}),
      },
      chrome.runtime.getManifest().version,
      Date.now(),
    );
  });
  return composeBackgroundGraph();
}
