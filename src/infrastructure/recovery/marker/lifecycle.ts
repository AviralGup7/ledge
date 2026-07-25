// E2-T07 · crash-marker lifecycle — the I/O shell around the pure classifier.
//
// Boot wake order (durability boundaries are load-bearing; the kill points in
// ops/chaos/points.txt fence exactly these):
//
//   1. READ session alive          (≤2ms hot path — one read gates the classification)
//   2. READ local install + boot   (only when alive is absent — warm wakes pay
//                                   exactly ONE storage read, never three)
//   3. classify (pure)
//   4. ARM session alive
//      —— kill point boot.marker.arm (armed, no boot stamp: the NEXT browser
//      restart classifies from the previous cycle's boot stamp, which stays
//      lawful — or from no stamp at all, which collapses to first-run on a
//      virgin device)
//   5. STAMP local boot
//      —— kill point boot.marker.stamp also fences the onInstalled wake: an
//      install stamp durably written while its wake dies before arming —
//      the NEXT boot sees a fresh stamp ⇒ 'updated', exactly R16.
//
// Writes are HOT-FLAG quality (best-effort, gap-disclosed): a failed marker
// write never fails the boot. The classifier's truth comes from what IS
// durable, and the next wake re-derives everything from the same records.
import type { StorageAreaPort } from '@/application/ports/storage-area.port.js';
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { classifyBoot } from './classify.js';
import type {
  AliveMarker,
  BootMarker,
  BootSignal,
  ClassifyInput,
  InstallMarker,
  InstallReason,
} from './types.js';
import { MARKER_KEYS, MARKER_SCHEMA_V } from './types.js';

// ---------------------------------------------------------------------------
// Tolerant record readers (ADR-033 forward tolerance: unknown fields tolerated;
// a wrong shape is treated as ABSENT with a 'marker-unreadable' gap — the
// classifier is never handed garbage and never throws on storage content).
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isInstallReason = (v: unknown): v is InstallReason =>
  v === 'install' || v === 'update' || v === 'chrome_update' || v === 'shared_module_update';

export const readAliveMarker = (v: unknown): AliveMarker | null =>
  isRecord(v) &&
  v['schemaV'] === MARKER_SCHEMA_V &&
  typeof v['bootSeq'] === 'number' &&
  typeof v['version'] === 'string' &&
  typeof v['atTs'] === 'number'
    ? { schemaV: MARKER_SCHEMA_V, bootSeq: v['bootSeq'], version: v['version'], atTs: v['atTs'] }
    : null;

export const readInstallMarker = (v: unknown): InstallMarker | null =>
  isRecord(v) &&
  v['schemaV'] === MARKER_SCHEMA_V &&
  isInstallReason(v['reason']) &&
  typeof v['version'] === 'string' &&
  typeof v['atTs'] === 'number'
    ? {
        schemaV: MARKER_SCHEMA_V,
        reason: v['reason'],
        previousVersion: typeof v['previousVersion'] === 'string' ? v['previousVersion'] : null,
        version: v['version'],
        atTs: v['atTs'],
      }
    : null;

export const readBootMarker = (v: unknown): BootMarker | null =>
  isRecord(v) &&
  v['schemaV'] === MARKER_SCHEMA_V &&
  typeof v['bootSeq'] === 'number' &&
  typeof v['version'] === 'string' &&
  typeof v['atTs'] === 'number'
    ? { schemaV: MARKER_SCHEMA_V, bootSeq: v['bootSeq'], version: v['version'], atTs: v['atTs'] }
    : null;

// ---------------------------------------------------------------------------
// onInstalled stamp (EES-R16's disambiguator input).
// ---------------------------------------------------------------------------

export interface InstallDetails {
  readonly reason: InstallReason;
  readonly previousVersion?: string | undefined;
}

/** Called from the (synchronously-registered) onInstalled listener. */
export const stampInstallMarker = async (
  area: StorageAreaPort,
  details: InstallDetails,
  version: string,
  now: number,
): Promise<Result<void, LedgeError>> => {
  const stamp: InstallMarker = {
    schemaV: MARKER_SCHEMA_V,
    reason: details.reason,
    previousVersion: details.previousVersion ?? null,
    version,
    atTs: now,
  };
  return area.localSet(MARKER_KEYS.install, stamp);
};

// ---------------------------------------------------------------------------
// Boot marker sequence.
// ---------------------------------------------------------------------------

export interface BootMarkerDeps {
  readonly area: StorageAreaPort;
  readonly version: string;
  readonly now: () => number;
}

interface MarkerImage {
  readonly input: ClassifyInput;
  readonly previousBootSeq: number;
  readonly gaps: string[];
}

/** Read the marker image; only the session read gates warm classification. */
const readImage = async (deps: BootMarkerDeps): Promise<MarkerImage> => {
  const gaps: string[] = [];
  const aliveResult = await deps.area.sessionGet(MARKER_KEYS.alive);
  if (!aliveResult.ok) {
    // E_CAPABILITY (FF parity) or a raw storage failure: the crash signal is
    // impossible to read this wake — undetectable, disclosed, never guessed.
    gaps.push(`alive-marker-read:${aliveResult.error.code}`);
    return {
      input: {
        sessionReadable: false,
        alive: null,
        aliveAbsentProven: false,
        install: null,
        boot: null,
      },
      previousBootSeq: 0,
      gaps,
    };
  }
  const aliveRaw = aliveResult.value;
  const alive = readAliveMarker(aliveRaw);
  if (alive !== null) {
    // Warm path: exactly one read (EES §6 hot-path law).
    return {
      input: { sessionReadable: true, alive, aliveAbsentProven: false, install: null, boot: null },
      previousBootSeq: alive.bootSeq,
      gaps,
    };
  }
  if (aliveRaw !== null) gaps.push(`marker-unreadable:${MARKER_KEYS.alive}`);

  // Abnormal path: the alive bit is provably absent — gather local evidence.
  const installResult = await deps.area.localGet(MARKER_KEYS.install);
  let install: InstallMarker | null = null;
  if (!installResult.ok) {
    gaps.push(`install-marker-read:${installResult.error.code}`);
  } else {
    install = readInstallMarker(installResult.value);
    if (install === null && installResult.value !== null) {
      gaps.push(`marker-unreadable:${MARKER_KEYS.install}`);
    }
  }
  const bootResult = await deps.area.localGet(MARKER_KEYS.boot);
  let boot: BootMarker | null = null;
  if (!bootResult.ok) {
    gaps.push(`boot-marker-read:${bootResult.error.code}`);
  } else {
    boot = readBootMarker(bootResult.value);
    if (boot === null && bootResult.value !== null) {
      gaps.push(`marker-unreadable:${MARKER_KEYS.boot}`);
    }
  }
  return {
    input: {
      sessionReadable: true,
      alive: null,
      aliveAbsentProven: true,
      install,
      boot,
    },
    previousBootSeq: boot?.bootSeq ?? 0,
    gaps,
  };
};

/**
 * Run the boot marker sequence: read → classify → arm → stamp. The returned
 * signal always reflects the pre-arm image (arm/stamp prepare the NEXT wake's
 * evidence; they never rewrite this wake's cause).
 */
export const bootMarkerSequence = async (
  deps: BootMarkerDeps,
): Promise<Result<BootSignal, LedgeError>> => {
  const image = await readImage(deps);
  const signal = classifyBoot(image.input);
  const gaps = [...image.gaps, ...signal.gaps];
  const bootSeq = image.previousBootSeq + 1;

  // (4) arm — best-effort; on a sessionless browser the E_CAPABILITY is exactly
  // what produced 'undetectable' above, so re-disclosing it skips cleanly.
  if (image.input.sessionReadable) {
    const alive: AliveMarker = {
      schemaV: MARKER_SCHEMA_V,
      bootSeq,
      version: deps.version,
      atTs: deps.now(),
    };
    const armed = await deps.area.sessionSet(MARKER_KEYS.alive, alive);
    if (!armed.ok) gaps.push(`alive-marker-arm:${armed.error.code}`);
  }

  // (5) boot stamp — best-effort; local failures leave the next wake a
  // marker-poorer image, which the classifier still maps (conservative table).
  // Both writes are gated on sessionReadable: stamping records into a
  // sessionless browser would mint a 'updated/crashed' false trail when the
  // capability returns (a fresh session area would read alive-absent against
  // a stamp the crash signal could never have armed).
  if (image.input.sessionReadable) {
    const stamp: BootMarker = {
      schemaV: MARKER_SCHEMA_V,
      bootSeq,
      version: deps.version,
      atTs: deps.now(),
    };
    const stamped = await deps.area.localSet(MARKER_KEYS.boot, stamp);
    if (!stamped.ok) gaps.push(`boot-marker-stamp:${stamped.error.code}`);
  }

  return ok({ ...signal, gaps });
};
