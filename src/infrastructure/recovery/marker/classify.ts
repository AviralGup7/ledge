// E2-T07 · pure boot classification — the ADR-007 §4 / EES-R16 decision table,
// IO-free so property suites can hold it against a model. Every branch is
// documented with the scenario it proves. The table is TOTAL: every marker
// image maps to exactly one cause, and no image throws.
//
// Decision table (in load-bearing order):
//
//   0. Session area unavailable/unreadable (E_CAPABILITY, storage failure)
//      ⇒ undetectable — without the survive-recycle area, crash detection
//      itself is impossible; fabricating crash/update from a broken signal is
//      exactly what the conservative law forbids.
//   1. Alive present (and parseable)
//      ⇒ warm-recycle — the session never died: SW recycled inside a live
//      browser. Invisible by design, whatever the local stamps say.
//   2. No install stamp AND no boot stamp
//      ⇒ first-run — nothing ever installed here (W1 owns the ceremony).
//   3. No boot stamp, install stamp reason = 'install'
//      ⇒ first-run — the install wake itself; if the first boot DIED mid-arm
//      the image is identical and collapses here too (W1 re-entry is
//      idempotent; never fabricate a crash we cannot prove).
//   4. No boot stamp, install stamp reason ∈ update-family
//      ⇒ updated — an update stamp with no completed boot can only arrive
//      after an install, so a boot once existed and was lost with its stamp;
//      the stamp is the freshest truth we have.
//   5. Install stamp newer than the last boot, or its version differs from
//      the version that boot ran
//      ⇒ updated — R16's disambiguation: something updated SINCE we last ran;
//      the restart was update-driven (update|chrome_update|shared_module_update).
//      Timestamp ties decide AGAINST updated (a stamp exactly as old as the
//      boot was consumed BY that boot).
//   6. Otherwise
//      ⇒ crashed — browser terminated while we ran this same build; nothing
//      in the markers says an update intervened.
//
// Conservative compass: when the image cannot prove an update, the cause falls
// to the branch that keeps the witnessing ceremony available ('crashed'); the
// §14.4 gate then decides whether any copy shows at all.
import type { BootCause, BootSignal, ClassifyInput, RecoveryCopyKey } from './types.js';
import { MARKER_KEYS } from './types.js';

const UPDATE_FAMILY: readonly string[] = ['update', 'chrome_update', 'shared_module_update'];

const decide = (input: ClassifyInput): BootCause => {
  if (!input.sessionReadable) return 'undetectable';
  if (input.alive !== null) return 'warm-recycle';
  // Absence must be PROVEN (read succeeded, nothing there); an unreadable
  // session area already returned 'undetectable' via sessionReadable=false.
  if (!input.aliveAbsentProven) return 'undetectable';
  const { install, boot } = input;
  if (install === null && boot === null) return 'first-run';
  if (boot === null) {
    return install !== null && install.reason !== 'install' ? 'updated' : 'first-run';
  }
  if (install !== null && UPDATE_FAMILY.includes(install.reason)) {
    if (install.version !== boot.version) return 'updated';
    if (install.atTs > boot.atTs) return 'updated';
  }
  return 'crashed';
};

/** Classify a storage image. Pure, total, deterministic. */
export const classifyBoot = (input: ClassifyInput): BootSignal => {
  const cause = decide(input);
  return {
    cause,
    abnormal: cause === 'updated' || cause === 'crashed',
    evidence: {
      aliveSeen: input.alive !== null,
      installReason: input.install?.reason ?? null,
      installedVersion: input.install?.version ?? null,
      lastBootVersion: input.boot?.version ?? null,
      installedAt: input.install?.atTs ?? null,
      lastBootAt: input.boot?.atTs ?? null,
    },
    gaps: [],
  };
};

/**
 * BootReport copy gating (EES-R16 + Blueprint §14.4/§6 line 687 — the card-law):
 *  - lossRisk ∧ updated ⇒ 'msg.recovery.updated'    (card copy)
 *  - lossRisk ∧ crashed ⇒ 'msg.recovery.crashed'    (card copy)
 *  - clean ∧ abnormal   ⇒ 'msg.heartbeat.recovered' (guardian heartbeat state —
 *    clean-but-abnormal exits NEVER open a card; §14.4 gates cards on loss-risk)
 *  - anything else      ⇒ null (warm recycles and first runs are invisible)
 * The key is data for the surface; copy renders from the catalog by key only.
 */
export const copyKeyFor = (cause: BootCause, lossRisk: boolean): RecoveryCopyKey => {
  if (cause === 'updated') return lossRisk ? 'msg.recovery.updated' : 'msg.heartbeat.recovered';
  if (cause === 'crashed') return lossRisk ? 'msg.recovery.crashed' : 'msg.heartbeat.recovered';
  return null;
};

export { MARKER_KEYS };
