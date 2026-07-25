// E2-T07 · runBootSequence — the recovery family's public interface per
// Blueprint §2.12: runBootSequence() → BootReport (clean | recovered |
// reconciled(precise scope)). Composes the two halves of the boot law
// (§6.2 SW wake):
//
//   1. crash-marker lifecycle (E2-T07): read → classify → arm → stamp.
//      Produces the BootSignal that answers "what ended the last session"
//      (ADR-007 §4) with the R16 update-vs-crash disambiguation.
//   2. boot reconcile (E2-T06): integrity probe → evidence → resolution
//      ladder → projections catch-up → cross-check. Consumes the signal as an
//      explicit input and embeds it in BootReport.bootSignal with the
//      §14.4-gated copy path (the card-law's single evaluation site).
//
// Marker failures never block the reconcile (the signal degrades to
// 'undetectable' with gaps; the journal remains the only source of truth);
// reconcile failures surface as err with the boot signal already recorded.
import type { StorageAreaPort } from '@/application/ports/storage-area.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { bootMarkerSequence } from './marker/index.js';
import type { BootSignal } from './marker/index.js';
import { reconcileBoot } from './reconciler/index.js';
import type { BootReport, ReconcilerDeps } from './reconciler/index.js';

export interface RecoveryBootDeps {
  readonly reconciler: ReconcilerDeps;
  /** Marker seam: chrome.storage local/session adapter (EES §6 StorageAreaPort). */
  readonly area: StorageAreaPort;
  /** Manifest version of the running build (marker stamps + disambiguation). */
  readonly version: string;
}

export const runBootSequence = async (
  deps: RecoveryBootDeps,
): Promise<Result<BootReport, LedgeError>> => {
  // The marker must classify BEFORE the reconcile writes resolution events:
  // the signal reads the pre-boot storage image, and boot-time stamping is
  // part of the marker evidence chain itself. Marker failure ⇒ degraded
  // signal, never a blocked boot (gaps carry the disclosure).
  const signal: BootSignal = await bootMarkerSequence({
    area: deps.area,
    version: deps.version,
    now: deps.reconciler.now,
  }).then((r) =>
    r.ok
      ? r.value
      : {
          cause: 'undetectable' as const,
          abnormal: false,
          evidence: {
            aliveSeen: false,
            installReason: null,
            installedVersion: null,
            lastBootVersion: null,
            installedAt: null,
            lastBootAt: null,
          },
          gaps: [`marker-sequence:${r.error.code}`],
        },
  );
  return reconcileBoot(deps.reconciler, signal);
};
