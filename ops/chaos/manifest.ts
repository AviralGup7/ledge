// E2-T09 · chaos manifest — the machine-readable binding from every
// ops/chaos/points.txt line to (a) its OWNER suite (flow-partition law:
// reconciler owns the flow boundaries, marker owns the boot markers; the
// cross-suite constitution asserts the partition is exact and disjoint) and
// (b) the expectation the driver sweep must observe.
//
// The reconciler half is DERIVED from KILL_POINT_FIXTURES (the single
// point⇒(torn-state, expectation) catalog lifted into the reconciler testkit)
// — the manifest never restates it. The marker half pins the canonical
// classification verdict per boot point (the owner suite asserts the same
// laws in depth).
import type { BootCause } from '@/infrastructure/recovery/marker/index.js';
import { BOOT_MARKER_KILL_POINTS } from '@/infrastructure/recovery/marker/testkit.js';
import {
  KILL_POINT_FIXTURES,
  type KillPointFixture,
} from '@/infrastructure/recovery/reconciler/testkit.js';

export type PointOwner = 'reconciler' | 'marker';

export interface ReconcilerPointBinding {
  readonly point: string;
  readonly owner: 'reconciler';
  readonly fixture: KillPointFixture;
}

export interface MarkerPointExpectation {
  /** Next-boot classification after the torn wake (BootSignal.cause). */
  readonly cause: BootCause;
  /** Copy gating verdict at lossRisk=true (catalog key or null). */
  readonly copyKey: string | null;
  /** Follow-on boot's cause (self-heal law / R16 no-double). */
  readonly followUpCause: BootCause;
}

export interface MarkerPointBinding {
  readonly point: string;
  readonly owner: 'marker';
  readonly expected: MarkerPointExpectation;
}

export type PointBinding = ReconcilerPointBinding | MarkerPointBinding;

/**
 * Marker-law expectations — sourced from the E2-T07 chaos suite's own
 * scenarios (one canonical scenario per point) and the §14.4/§6 copy gate:
 * boot.marker.arm   — kill after alive-arm, before boot stamp: the previous
 *                     completed cycle's stamps govern ⇒ crash (self-heal warm).
 * boot.marker.stamp — truncated onInstalled update wake: fresh v2 stamp with
 *                     version moved ⇒ updated; later same-build ⇒ crash (R16).
 */
export const MARKER_POINT_EXPECTATIONS: Readonly<Record<string, MarkerPointExpectation>> = {
  'boot.marker.arm': {
    cause: 'crashed',
    copyKey: 'msg.recovery.crashed',
    followUpCause: 'warm-recycle',
  },
  'boot.marker.stamp': {
    cause: 'updated',
    copyKey: 'msg.recovery.updated',
    followUpCause: 'crashed',
  },
};

export const POINT_BINDINGS: readonly PointBinding[] = [
  ...KILL_POINT_FIXTURES.map((fixture) => ({
    point: fixture.point,
    owner: 'reconciler' as const,
    fixture,
  })),
  ...BOOT_MARKER_KILL_POINTS.map((point) => {
    const expected = MARKER_POINT_EXPECTATIONS[point];
    if (expected === undefined) {
      // Fail CLOSED at module load: a marker point without an expectation is a
      // harness constitution bug, never a skipped data row.
      throw new Error(`chaos manifest: no expectation bound for marker point ${point}`);
    }
    return { point, owner: 'marker' as const, expected };
  }),
];
