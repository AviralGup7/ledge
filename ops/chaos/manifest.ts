// E2-T09 · chaos manifest — the machine-readable binding from every
// ops/chaos/points.txt line to (a) its OWNER suite (flow-partition law:
// reconciler owns the flow boundaries, marker owns the boot markers,
// journal/compact owns the E2-T11 sweep boundaries; the cross-suite
// constitution asserts the partition is exact and disjoint) and
// (b) the expectation the driver sweep must observe.
//
// The reconciler half is DERIVED from KILL_POINT_FIXTURES (the single
// point⇒(torn-state, expectation) catalog lifted into the reconciler testkit)
// — the manifest never restates it. The marker half pins the canonical
// classification verdict per boot point (the owner suite asserts the same
// laws in depth). The compact half pins the resume verdict per sweep point.
import { COMPACT_KILL_POINTS } from '@/infrastructure/journal/compact/testkit.js';
import type { BootCause } from '@/infrastructure/recovery/marker/index.js';
import { BOOT_MARKER_KILL_POINTS } from '@/infrastructure/recovery/marker/testkit.js';
import {
  KILL_POINT_FIXTURES,
  type KillPointFixture,
} from '@/infrastructure/recovery/reconciler/testkit.js';

export type PointOwner = 'reconciler' | 'marker' | 'compact';

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

export interface CompactPointExpectation {
  /** compact() over the torn image RESUMED (running baseline, same plan)? */
  readonly resumed: boolean;
  /** ...or replayed as a byte-true no-op (done baseline, same plan). */
  readonly noOp: boolean;
  /** Total exclusions the epoch must report after convergence. */
  readonly entriesExcluded: number;
}

export interface CompactPointBinding {
  readonly point: string;
  readonly owner: 'compact';
  readonly expected: CompactPointExpectation;
}

export type PointBinding = ReconcilerPointBinding | MarkerPointBinding | CompactPointBinding;

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

/**
 * Compact-law expectations — the canonical chaos plan (driver: 2 exclusions,
 * one per window segment, chunkSegments 1):
 * compact.segment-rewrite.mid — chunk 0 of 2 committed: resume is a true
 *                               continuation (carried + fresh = 2 exclusions).
 * compact.baseline-flip.before — window exhausted, never flipped: resume flips.
 * compact.checkpoint.mid       — flipped done, restamp killed: same-plan replay
 *                                is a byte-true no-op that restamps.
 */
export const COMPACT_POINT_EXPECTATIONS: Readonly<Record<string, CompactPointExpectation>> = {
  'compact.segment-rewrite.mid': { resumed: true, noOp: false, entriesExcluded: 2 },
  'compact.baseline-flip.before': { resumed: true, noOp: false, entriesExcluded: 2 },
  'compact.checkpoint.mid': { resumed: false, noOp: true, entriesExcluded: 2 },
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
  ...COMPACT_KILL_POINTS.map((point) => {
    const expected = COMPACT_POINT_EXPECTATIONS[point];
    if (expected === undefined) {
      throw new Error(`chaos manifest: no expectation bound for compact point ${point}`);
    }
    return { point, owner: 'compact' as const, expected };
  }),
];
