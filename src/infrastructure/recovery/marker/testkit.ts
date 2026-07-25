// E2-T07 marker fixtures (TEST-ONLY — journal/core/testkit.ts precedent).
// A scripted StorageAreaPort fake (independent local/session namespaces, per-op
// sabotage queue, call counters for the warm-path one-read law, restart/recycle
// simulation per ADR-007 §4) + schemaV'd marker record factories. Deterministic:
// ids and clocks are caller-driven; nothing random lives here.
import type { StorageAreaPort } from '@/application/ports/storage-area.port.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { bootMarkerSequence, stampInstallMarker } from './lifecycle.js';
import type { AliveMarker, BootMarker, BootSignal, InstallMarker, InstallReason } from './types.js';
import { MARKER_KEYS, MARKER_SCHEMA_V } from './types.js';

/** Kill points THIS suite owns in ops/chaos/points.txt (flow-partition law). */
export const BOOT_MARKER_KILL_POINTS: readonly string[] = ['boot.marker.arm', 'boot.marker.stamp'];

export const VERSION_1 = '1.0.0';
export const VERSION_2 = '2.0.0';
const MARKER_WALL_BASE = 1_900_000_000_000;

export const makeAlive = (over: Partial<AliveMarker> = {}): AliveMarker => ({
  schemaV: MARKER_SCHEMA_V,
  bootSeq: 1,
  version: VERSION_1,
  atTs: MARKER_WALL_BASE,
  ...over,
});

export const makeInstall = (over: Partial<InstallMarker> = {}): InstallMarker => ({
  schemaV: MARKER_SCHEMA_V,
  reason: 'install',
  previousVersion: null,
  version: VERSION_1,
  atTs: MARKER_WALL_BASE,
  ...over,
});

export const makeBoot = (over: Partial<BootMarker> = {}): BootMarker => ({
  schemaV: MARKER_SCHEMA_V,
  bootSeq: 1,
  version: VERSION_1,
  atTs: MARKER_WALL_BASE,
  ...over,
});

// ---------------------------------------------------------------------------
// Scripted area fake.
// ---------------------------------------------------------------------------

type AreaName = 'local' | 'session';
type OpName = 'get' | 'set';
export type SabotageOp = `${AreaName}.${OpName}`;

export interface MarkerArea {
  readonly port: StorageAreaPort;
  readonly counts: Record<SabotageOp, number>;
  /**
   * Queue a one-shot typed failure at an op boundary. `key` scopes the
   * sabotage to ops touching that exact storage key (a two-phase boundary
   * failure targets a RECORD, not whichever set happens to run next —
   * e.g. boot.marker.stamp must never poison an install stamp).
   */
  readonly failNext: (op: SabotageOp, code: LedgeError['code'], key?: string) => void;
  /** Browser restart (ADR-007 §4): session dies, local persists. */
  readonly restartBrowser: () => void;
  /** Firefox parity: make the session area vanish (ops answer E_CAPABILITY). */
  readonly dropSessionArea: () => void;
  /** Raw area contents (marker-record assertions). */
  readonly raw: (area: AreaName) => Record<string, unknown>;
}

interface QueuedFailure {
  readonly op: SabotageOp;
  readonly code: LedgeError['code'];
  readonly key: string | undefined;
}

export const makeMarkerArea = (): MarkerArea => {
  const localData = new Map<string, unknown>();
  let sessionData: Map<string, unknown> | null = new Map();
  const failures: QueuedFailure[] = [];
  const counts: Record<SabotageOp, number> = {
    'local.get': 0,
    'local.set': 0,
    'session.get': 0,
    'session.set': 0,
  };

  const consume = (op: SabotageOp, key: string): LedgeError | null => {
    counts[op] += 1;
    const index = failures.findIndex((f) => f.op === op && (f.key === undefined || f.key === key));
    if (index === -1) return null;
    const [failure] = failures.splice(index, 1);
    return ledgeError(failure?.code ?? 'E_CAPABILITY_API', { op, key, site: 'test-sabotage' });
  };

  const get =
    (area: AreaName) =>
    (key: string): Promise<Result<unknown, LedgeError>> => {
      const failure = consume(`${area}.get`, key);
      if (failure !== null) return Promise.resolve(err(failure));
      if (area === 'session' && sessionData === null) {
        return Promise.resolve(
          err(ledgeError('E_CAPABILITY', { area: 'session', parity: 'firefox' })),
        );
      }
      const data = area === 'local' ? localData : (sessionData as Map<string, unknown>);
      return Promise.resolve(ok(data.has(key) ? data.get(key) : null));
    };

  const set =
    (area: AreaName) =>
    (key: string, value: unknown): Promise<Result<void, LedgeError>> => {
      const failure = consume(`${area}.set`, key);
      if (failure !== null) return Promise.resolve(err(failure));
      if (area === 'session' && sessionData === null) {
        return Promise.resolve(
          err(ledgeError('E_CAPABILITY', { area: 'session', parity: 'firefox' })),
        );
      }
      const data = area === 'local' ? localData : (sessionData as Map<string, unknown>);
      data.set(key, value);
      return Promise.resolve(ok(undefined));
    };

  return {
    port: {
      localGet: get('local'),
      localSet: set('local'),
      sessionGet: get('session'),
      sessionSet: set('session'),
    },
    counts,
    failNext: (op, code, key) => {
      failures.push({ op, code, key });
    },
    restartBrowser: () => {
      if (sessionData !== null) sessionData = new Map();
    },
    dropSessionArea: () => {
      sessionData = null;
    },
    raw: (area) =>
      Object.fromEntries(
        area === 'local' ? localData : (sessionData ?? new Map<string, unknown>()),
      ),
  };
};

// ---------------------------------------------------------------------------
// Wake drivers (the lifecycle halves, killable between them).
// ---------------------------------------------------------------------------

export interface TickClock {
  readonly now: () => number;
  readonly tick: (step?: number) => number;
}

export const makeClock = (start = MARKER_WALL_BASE): TickClock => {
  let t = start;
  return {
    now: () => t,
    tick: (step = 1) => {
      t += step;
      return t;
    },
  };
};

/** Full lifecycle wake (what production runs). */
export const runWake = (
  area: MarkerArea,
  version: string,
  clock: TickClock,
): Promise<Result<BootSignal, LedgeError>> =>
  bootMarkerSequence({ area: area.port, version, now: clock.now });

/** onInstalled wake stamp (EES-R16 disambiguator input). */
export const stampInstall = (
  area: MarkerArea,
  reason: InstallReason,
  version: string,
  clock: TickClock,
  previousVersion?: string,
): Promise<Result<void, LedgeError>> =>
  stampInstallMarker(
    area.port,
    { reason, ...(previousVersion !== undefined ? { previousVersion } : {}) },
    version,
    clock.now(),
  );

export { MARKER_KEYS };
