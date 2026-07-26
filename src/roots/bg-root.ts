// Background composition root (ADR-025 · E1-T12) — the ONLY place background
// application↔infrastructure wiring may live. Construction and activation are split:
//   compose*   — chrome-free graph construction (node-testable; contexts boot with
//                stub adapters per EES §9.16 — tests inject the memory storage
//                adapter and stub entropy through BackgroundGraphDeps).
//   bootstrap* — thin activation: lifecycle listeners register synchronously
//                (MV3 law, ADR-007), then the composed graph is returned.
// No domain logic lands here: hub, ingest and recovery wire against this seam in E2.
import type { MessageZone } from '@/application/contracts/index.js';
import { createAppEventBus, type AppEventBus } from '@/application/hub/dispatch/app-events.js';
import { createDispatcher, type Dispatcher } from '@/application/hub/dispatch/dispatcher.js';
import { createRingLogSink } from '@/application/hub/dispatch/log.js';
import { createHandlerRegistry } from '@/application/hub/dispatch/registry.js';
import { createIngestHub, type IngestHub } from '@/application/hub/ingest/index.js';
import {
  createOutbox,
  type Outbox,
  type WireStreamMessage,
} from '@/application/hub/outbox/index.js';
import type { ExporterPort, ImporterPort } from '@/application/ports/import-export.port.js';
import type { SearchRankPort } from '@/application/ports/search.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import type { SnapshotsPort } from '@/application/ports/snapshots.port.js';
import type { StoreName } from '@/application/ports/storage-engine.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { TabsPort } from '@/application/ports/tabs.port.js';
import type { WindowsPort } from '@/application/ports/windows.port.js';
import {
  INTERNAL_COMMANDS,
  INTERNAL_QUERIES,
  WIRE_COMMANDS,
  WIRE_QUERIES,
} from '@/application/usecases/handlers.js';
import { createServices, type AppServices } from '@/application/usecases/index.js';
import {
  createChromeStorageAreaAdapter,
  createChromeTabsAdapter,
  createChromeWindowsAdapter,
} from '@/infrastructure/chrome/index.js';
import { createIntentLedger } from '@/infrastructure/intents/ledger.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { createV1ProjectionEngine } from '@/infrastructure/projections/index.js';
import { stampInstallMarker } from '@/infrastructure/recovery/marker/index.js';
import { createSearchRankAdapter } from '@/infrastructure/search/index.js';
import { createSnapshotsAdapter } from '@/infrastructure/snapshots/index.js';
import { createDexieStorageEngine, type DexieEngineDeps } from '@/infrastructure/storage/index.js';
import {
  createDeviceId,
  isDeviceId,
  platformIds,
  platformNow,
  type DeviceId,
  type IdGenerator,
  type Now,
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
  /** E3-APP runtime seams (adapter injections for chrome-free composition tests). */
  readonly runtime?: BackgroundRuntimeDeps;
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

// ─────────────────────────── E3-APP runtime (post-boot) ───────────────────────────

/** E3-APP · The application runtime the surfaces talk to. Everything behind the
 *  dependency-law line (UI ⇄ Application ⇄ Domain ⇄ Infrastructure) is assembled
 *  HERE and only here: one StreamAppender (the per-device stamping authority — the
 *  law is per-GRAPH), one bus, two dispatchers (wire + Tier-2 internal registries
 *  riding the same bus), the §3.5 outbox translating lifecycle facts to frozen
 *  stream names. */
export interface BackgroundRuntime {
  readonly bus: AppEventBus;
  readonly services: AppServices;
  /** Frozen EES §3 registry — exactly the v1 wire names (parity-law enforced). */
  readonly wire: Dispatcher;
  /** Internal Tier-2 commands (Recent Activity / favorites / redo / topic teaching)
   *  — never wire-addressable; surfaces reach them through the message router. */
  readonly internal: Dispatcher;
  readonly outbox: Outbox;
  /** Dispatch a validated envelope (SW message-router seam, channel or zone). */
  readonly dispatch: (raw: unknown, zone: MessageZone) => unknown;
  /** Unsubscribe outbox/chrome-event subscriptions (test teardown). */
  readonly stop: () => void;
}

export interface BackgroundRuntimeDeps {
  readonly ids?: IdGenerator | undefined;
  readonly now?: Now | undefined;
  /** §6 port seams — production binds lazy chrome adapters (EES §9.16 stubs in tests). */
  readonly tabs?: TabsPort | undefined;
  readonly windows?: WindowsPort | undefined;
  /** Snapshot port seam (default: the snapshots-family adapter over builder law). */
  readonly snapshots?: SnapshotsPort | undefined;
  /** Ingest seam; default built over the platform scheduler (adapter-tier activation
   *  — wiring chrome.tab events into the hub — is the browser-adapters milestone). */
  readonly ingest?: IngestHub | undefined;
  /** E5 portability families — unwired in v1 ⇒ services answer honest E_CAPABILITY. */
  readonly importer?: ImporterPort | undefined;
  readonly exporter?: ExporterPort | undefined;
  /** E5-T01 rank seam (test override point; default = the live index adapter). */
  readonly search?: SearchRankPort | undefined;
  /** §3.5 transport seam; default is the guarded chrome.runtime broadcast (silent
   *  drop when no surface is listening — streams are fire-and-forget by law). */
  readonly publish?: ((message: WireStreamMessage) => void) | undefined;
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
  /**
   * E3-APP runtime handle: resolves AFTER boot (the StreamAppender's device stamp
   * and the projections engine both hang off boot truth). A boot failure fails
   * here identically — callers never assemble a runtime from a half-booted graph.
   */
  readonly runtime: Promise<Result<BackgroundRuntime, LedgeError>>;
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

/** Platform scheduler (SW-safe setTimeout; the only ambient timer the root owns). */
const PLATFORM_SCHEDULER: { readonly after: (delayMs: number, fn: () => void) => () => void } = {
  after: (delayMs, fn) => {
    const t = setTimeout(fn, delayMs);
    return () => {
      clearTimeout(t);
    };
  },
};

/** §3.5 default transport: broadcast to listening surfaces; silence when none. */
const guardedBroadcast = (message: WireStreamMessage): void => {
  try {
    void chrome.runtime.sendMessage({
      v: CONTRACT_V,
      kind: 'stream',
      name: message.name,
      payload: message.payload,
    });
  } catch {
    // No surface listening (or SW-context oddity): streams are additive fire-and-
    // forget — a transport absence never reaches the authority path (§2.6).
  }
};

/** E3-APP · assemble the application runtime from boot truth (device-anchored). */
const buildRuntime = (
  storage: StorageEnginePort,
  journal: JournalPort,
  booted: BackgroundBoot,
  deps: BackgroundRuntimeDeps,
): BackgroundRuntime => {
  const ids = deps.ids ?? platformIds;
  const now = deps.now ?? platformNow;
  const bus = createAppEventBus();

  // services is referenced by the outbox's heartbeat seam before construction — the
  // heartbeat only fires post-Applied, strictly after this function returns.
  let servicesRef: AppServices | null = null;
  const outboxDeps = { bus, publish: deps.publish ?? guardedBroadcast };

  const outbox = createOutbox({
    ...outboxDeps,
    now,
    heartbeat: async () => {
      const r = await servicesRef?.queries.heartbeat();
      return r !== undefined && r.ok
        ? { ok: true as const, value: r.value }
        : { ok: false as const };
    },
  });

  const projections = createV1ProjectionEngine({
    engine: storage,
    journal,
    onDelta: outbox.onDelta,
  });
  // E5-T01 rank seam, composed once: services read it, the maintenance lane below
  // self-heals it. Idle-cheap until the first index build exists.
  const searchRank = deps.search ?? createSearchRankAdapter({ engine: storage, projections, now });
  const ledger = createIntentLedger({ engine: storage, journal });
  const services = createServices({
    engine: storage,
    journal,
    projections,
    ledger,
    snapshots: deps.snapshots ?? createSnapshotsAdapter({ engine: storage, ids }),
    tabs: deps.tabs ?? createChromeTabsAdapter(),
    windows: deps.windows ?? createChromeWindowsAdapter(),
    ids,
    deviceId: booted.deviceId,
    now,
    ...(deps.ingest !== undefined
      ? { ingest: deps.ingest }
      : {
          ingest: createIngestHub({
            journal,
            storage,
            deviceId: booted.deviceId,
            now,
            ids,
            scheduler: PLATFORM_SCHEDULER,
          }),
        }),
    ...(deps.importer !== undefined ? { importer: deps.importer } : {}),
    ...(deps.exporter !== undefined ? { exporter: deps.exporter } : {}),
    search: searchRank,
  });
  servicesRef = services;

  // E5-T01 maintenance lane (ADR-015 background reindex): a dirty/stale-tokenizer
  // index rebuilds in the engine's resumable chunks; queries stay sweep-honest in the
  // meantime (§2.11 fallback law). SW-chunked v1; §3.6 offscreen build is the 50k door.
  void searchRank.ensureIndexFresh();

  const wire = createDispatcher<AppServices>({
    registry: createHandlerRegistry({ commands: WIRE_COMMANDS, queries: WIRE_QUERIES }),
    services,
    logSink: createRingLogSink(),
    events: bus,
    now,
  });
  const internal = createDispatcher<AppServices>({
    registry: createHandlerRegistry({ commands: INTERNAL_COMMANDS, queries: INTERNAL_QUERIES }),
    services,
    logSink: createRingLogSink(),
    events: bus,
    now,
    // Tier-2 validation: internal names have no §3 wire-registry rows — the roster IS
    // the contract (envelope-shape laws still apply; payload typing is the handler's).
    internal: {
      commands: INTERNAL_COMMANDS.map((c) => c.name),
      queries: INTERNAL_QUERIES.map((q) => q.name),
    },
  });
  const stopOutbox = outbox.start();

  return {
    bus,
    services,
    wire,
    internal,
    outbox,
    dispatch: (raw, zone) => {
      // Internal Tier-2 names route to the internal registry by name presence —
      // wire registries never serve them (parity law: wire ∩ internal = ∅).
      const name = (raw as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && INTERNAL_COMMANDS.some((c) => c.name === name))
        return internal.dispatch(raw, zone);
      if (typeof name === 'string' && INTERNAL_QUERIES.some((q) => q.name === name))
        return internal.dispatch(raw, zone);
      return wire.dispatch(raw, zone);
    },
    stop: () => {
      stopOutbox();
    },
  };
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
  // E3-APP: the runtime is a pure function of boot truth; boot failures fail it too.
  const runtime = boot.then((booted): Result<BackgroundRuntime, LedgeError> => {
    if (!booted.ok) return err(booted.error);
    try {
      return ok(buildRuntime(storage, journal, booted.value, deps.runtime ?? {}));
    } catch (cause) {
      return err(ledgeError('E_CORRUPT_STORE', { what: 'runtime-compose', cause: String(cause) }));
    }
  });
  return { storage, journal, boot, runtime };
}

/**
 * Activate the background context. Listeners register first and synchronously
 * (ADR-007); the async boot proceeds behind them and its Result is retained on
 * the returned graph. The onInstalled listener stamps the version-change
 * marker (EES-R16 disambiguator input) through the StorageAreaPort adapter —
 * the rest of the crash-marker lifecycle + boot reconcile (runBootSequence)
 * wires here when the recovery graph lands (ledger/projections composition).
 */
/**
 * E4 · Surface channel: the ONLY inbound wire path from extension pages
 * (ADR-007 sync listener; §2.6 dispatch is the single mutation entry). Any
 * runtime message from a Ledge page is validated + dispatched against the
 * booted runtime; the synchronous dispatch ANSWER (ack/ignored/rejected) is
 * the sendMessage response, and terminals/streams ride the §3.5 broadcast.
 * A dead boot answers rejected-with-error — surfaces render the calm boot
 * card, never a silent hang (totality: every send gets exactly one response).
 */
export function composeSurfaceChannel(graph: BackgroundGraph): void {
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    void (async (): Promise<void> => {
      const booted = await graph.runtime;
      if (!booted.ok) {
        sendResponse({ outcome: 'rejected', error: booted.error });
        return;
      }
      sendResponse(booted.value.dispatch(raw, 'zone0'));
    })();
    return true; // async sendResponse (MV3)
  });
}

export function bootstrapBackground(): BackgroundGraph {
  const channel = composeBackgroundGraph();
  composeSurfaceChannel(channel);
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
  return channel;
}
