// E2-T06 · boot reconciler — ADR-011 step 4, EES §2.13, EES §10-R2, Blueprint §5.
//
// Boot truth procedure (single-writer SW; nothing else mutates during this pass —
// the boot law sequence is: integrity probe → THIS reconcile → projections catch-up
// → cross-check → BootReport → only then adapters subscribe):
//
//   1. scanTail integrity probe. Degraded ⇒ recovered-report, NO mass writes
//      (writing resolutions after an unverified tail would append onto doubt).
//   2. Full-stream evidence scan (journal is the only proof source).
//   3. pending() intents, deterministic order (issuedAt, intentId). Per intent, the
//      decision ladder (conservative order is load-bearing):
//        a. abort-terminal durable     ⇒ converged to aborted (stable-lag).
//        b. complete-terminal durable  ⇒ converged to done (stable-lag).
//           Both re-drive = SEMANTIC restamp (fresh eventId/HLC, identical type +
//           payload) through ledger.complete/abort: the journal's seq-vs-head law
//           forbids replaying the stored envelope's old seq, and the intent-settle
//           idempotency key makes the restamp exactly-once thereafter. Consumers
//           dedupe the semantic duplicate by registry idempotentBy:intentId.
//        c. §10-R2: close-class intent whose scope tabs are ALL externally closed
//           ⇒ completion stamped FROM EVIDENCE, secured counted once per
//           (intentId, browserTabId). Partial coverage ⇒ conservative abort
//           (leave-open+disclose) — never complete what cannot be re-proven.
//        d. park family without proof ⇒ ParkAborted leave-open (liveLeftOpen).
//        e. everything else (no abort row in §4, unmanaged kind, write failure)
//           ⇒ DEFER + noteRetry + disclose. Defer is never silent.
//   4. Projections catch-up (applyFromJournal) — read models converge to the new
//      stream head; watermarks move forward only (recovery-after-interrupted law).
//   5. Sessions cross-check (degraded-unavailable until the adapter lands, EES
//      §2.13 failure law — logged gap, never a boot failure).
//   6. BootReport — ALWAYS produced, even clean. lossRisk gates the W7 card
//      (§14.4: card only on loss-risk).
import { advance, type Hlc } from '@/shared-kernel/clock/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { IntentRecord } from '@/application/ports/intent-ledger.port.js';
import type { IngestDraft } from '@/application/hub/ingest/index.js';
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { scanDeviceEvidence, trailFor, type DeviceEvidence } from './evidence.js';
import { copyKeyFor, type BootSignal } from '../marker/index.js';
import {
  buildConservativeAbort,
  buildEvidenceCompletion,
  policyFor,
  REASON,
  scopeTabRefs,
  type FamilyPolicy,
} from './policies.js';
import type {
  BootReport,
  IntentResolution,
  JournalProbeReport,
  ProjectionsBootReport,
  ReconcilerDeps,
} from './types.js';
import { RECONCILE_REPORT_SCHEMA_V } from './types.js';

interface StampState {
  cursor: Hlc;
}

/**
 * Fresh, contiguously-threaded envelopes for resolution drafts. The cursor is
 * COMMITTED only after a successful settle (commitCursor): an envelope stamped for
 * a write that then fails is discarded, never a durable hole — otherwise a stalled
 * resolution would burn a seq and every later resolution this boot would gap
 * against the stream head (defect B19, regression R16).
 */
const stampDrafts = (
  state: StampState,
  drafts: readonly IngestDraft[],
  deps: ReconcilerDeps,
): EventEnvelope[] => {
  const wall = deps.now();
  const out: EventEnvelope[] = [];
  let cursor = state.cursor;
  for (const draft of drafts) {
    cursor = advance(cursor, wall);
    out.push({
      eventId: deps.ids.nextId(),
      hlc: cursor,
      type: draft.type,
      payload: draft.payload,
      producerContext: 'sw',
    });
  }
  return out;
};

/** Advance the shared cursor past envelopes the ledger durably appended. */
const commitCursor = (state: StampState, appended: readonly EventEnvelope[]): void => {
  const last = appended[appended.length - 1];
  if (last !== undefined) state.cursor = last.hlc;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Semantic payload of a stored terminal event (type + payload), seq-free.
 *  Callers only ever pass policy-curated terminal rows (§4 names), so the
 *  envelope's forward-tolerant string type narrows lawfully to a catalog name. */
const semanticOf = (envelope: EventEnvelope): IngestDraft => ({
  type: envelope.type as IngestDraft['type'],
  payload: isRecord(envelope.payload) ? { ...envelope.payload } : {},
});

interface ResolutionScratch {
  coveredOnce: number;
  doubleCountPrevented: number;
}

/**
 * Decide + act on ONE dangling intent. Writes flow exclusively through the ledger's
 * terminal law (events+row in one txn); a write refusal converts to a deferred
 * disclosure — one intent's failure never stops the boot report.
 */
const resolveIntent = async (
  record: IntentRecord,
  evidence: DeviceEvidence,
  policy: FamilyPolicy,
  state: StampState,
  deps: ReconcilerDeps,
  scratch: ResolutionScratch,
): Promise<IntentResolution> => {
  const base = {
    intentId: record.intentId,
    cid: record.cid,
    kind: record.kind,
    evidenceTabs: [] as readonly number[],
    securedCounted: 0,
    liveLeftOpen: 0,
  };
  // noteRetry results are best-effort accounting — they never alter dispositions.
  const trail = trailFor(evidence, record.intentId as string);
  const envelopesOf = (types: readonly string[]): readonly EventEnvelope[] =>
    trail.events.filter((e) => types.includes(e.envelope.type)).map((e) => e.envelope);

  // §2.13 command→observation order: NOTHING can prove an intent before the
  // intent existed. The trail's first entry is its acceptance (hinged ack law);
  // only observations STRICTLY after it are evidence (defect B20, regression R20).
  // No trail ⇒ the row's provenance is unverifiable: defer, never act blind.
  if (trail.events.length === 0) {
    await deps.ledger.noteRetry(record.intentId);
    return {
      ...base,
      stale: 'lost-in-crash',
      disposition: 'deferred',
      reason: REASON.noAcceptanceTrail,
    };
  }
  const acceptanceSeq = trail.events[0]?.seq ?? Number.MAX_SAFE_INTEGER;

  // (a)+(b) durable terminal → converge the row (abort wins ties: the branch that
  // cannot destroy content is always preferred).
  const abortEnvelopes = envelopesOf(policy.abortTypes);
  const completeEnvelopes = envelopesOf(policy.completeTypes);
  const terminalPhase: 'abort' | 'complete' | null =
    abortEnvelopes.length > 0 ? 'abort' : completeEnvelopes.length > 0 ? 'complete' : null;
  if (terminalPhase !== null) {
    const stored = terminalPhase === 'abort' ? abortEnvelopes : completeEnvelopes;
    const restamped = stampDrafts(state, stored.map(semanticOf), deps);
    const settled =
      terminalPhase === 'abort'
        ? await deps.ledger.abort(record.intentId, restamped, deps.now())
        : await deps.ledger.complete(record.intentId, restamped, deps.now());
    if (settled.ok) {
      commitCursor(state, restamped);
      return {
        ...base,
        stale: 'stable-lag',
        disposition: 'completed-safe',
        reason: REASON.terminalDurable,
      };
    }
    await deps.ledger.noteRetry(record.intentId);
    return {
      ...base,
      stale: 'stable-lag',
      disposition: 'deferred',
      reason: REASON.writeFailed,
      errorCode: settled.error.code,
    };
  }

  // (c) §10-R2 close-evidence for close-class families with extractable refs —
  // temporally guarded: a close is evidence only when observed AFTER the intent's
  // acceptance (command→observation order). Stale closes from before the command
  // are noise (id reuse, yesterday's session), never proof.
  const refs = scopeTabRefs(record.scope);
  if (policy.r2Completes && refs !== null) {
    const closesAfter = new Set(
      evidence.externalCloses.filter((c) => c.seq > acceptanceSeq).map((c) => c.browserTabId),
    );
    const covered = refs.filter((r) => closesAfter.has(r));
    scratch.coveredOnce += covered.length;
    // Defensive double-count accounting: ingest finality (B17) makes duplicate
    // closes for one browserTabId impossible; if foreign/corrupt streams ever
    // show one anyway, the Set-based coverage already refused to count it twice.
    const closeSeqs = new Set(
      evidence.externalCloses
        .filter((c) => covered.includes(c.browserTabId))
        .map((c) => c.browserTabId),
    );
    scratch.doubleCountPrevented += Math.max(0, covered.length - closeSeqs.size);
    if (covered.length === refs.length && refs.length > 0) {
      const stamped = stampDrafts(
        state,
        [buildEvidenceCompletion(record.intentId, covered.length)],
        deps,
      );
      const settled = await deps.ledger.complete(record.intentId, stamped, deps.now());
      if (settled.ok) {
        commitCursor(state, stamped);
        return {
          ...base,
          stale: 'externally-closed',
          disposition: 'completed-evidence',
          reason: REASON.evidenceComplete,
          evidenceTabs: covered,
          securedCounted: covered.length,
        };
      }
      await deps.ledger.noteRetry(record.intentId);
      return {
        ...base,
        stale: 'externally-closed',
        disposition: 'deferred',
        reason: REASON.writeFailed,
        evidenceTabs: covered,
        errorCode: settled.error.code,
      };
    }
    if (covered.length > 0 && policy.hasAbortRow) {
      const left = refs.length - covered.length;
      const stamped = stampDrafts(state, [buildConservativeAbort(record.intentId, left)], deps);
      const settled = await deps.ledger.abort(record.intentId, stamped, deps.now());
      if (settled.ok) {
        commitCursor(state, stamped);
        return {
          ...base,
          stale: 'externally-closed',
          disposition: 'aborted-conservative',
          reason: REASON.evidencePartial,
          evidenceTabs: covered,
          liveLeftOpen: left,
        };
      }
      await deps.ledger.noteRetry(record.intentId);
      return {
        ...base,
        stale: 'externally-closed',
        disposition: 'deferred',
        reason: REASON.writeFailed,
        evidenceTabs: covered,
        errorCode: settled.error.code,
      };
    }
  }

  // (d) park family, zero proof → leave-open abort (liveLeftOpen best-known: scope
  // remainder when refs are readable; live probe when they are not).
  if (policy.family === 'park-close' && policy.hasAbortRow) {
    let liveLeftOpen = refs?.length ?? 0;
    if (refs === null && deps.liveTabsProbe !== undefined) {
      const probe = await deps.liveTabsProbe();
      if (probe.ok) liveLeftOpen = probe.value;
    }
    const stamped = stampDrafts(
      state,
      [buildConservativeAbort(record.intentId, liveLeftOpen)],
      deps,
    );
    const settled = await deps.ledger.abort(record.intentId, stamped, deps.now());
    if (settled.ok) {
      commitCursor(state, stamped);
      return {
        ...base,
        stale: 'lost-in-crash',
        disposition: 'aborted-conservative',
        reason: refs === null ? `${REASON.noEvidence}:scope-refs-unreadable` : REASON.noEvidence,
        liveLeftOpen,
      };
    }
    await deps.ledger.noteRetry(record.intentId);
    return {
      ...base,
      stale: 'lost-in-crash',
      disposition: 'deferred',
      reason: REASON.writeFailed,
      errorCode: settled.error.code,
    };
  }

  // (e) unprovable + no lawful abort row → defer + disclose (never improvises events).
  await deps.ledger.noteRetry(record.intentId);
  return {
    ...base,
    stale: 'lost-in-crash',
    disposition: 'deferred',
    reason: policy.family === 'universal' ? REASON.unknownKind : REASON.noAbortRow,
  };
};

/** §14.4 gating rule (kept pure + exported for property verification). */
export const assessLossRisk = (
  probe: JournalProbeReport,
  resolutions: readonly IntentResolution[],
): boolean => {
  if (!probe.ok) return true;
  for (const r of resolutions) {
    if (r.disposition === 'deferred') return true;
    // Partial execution aborted: the world is ambiguous → risk is real.
    if (r.disposition === 'aborted-conservative' && r.evidenceTabs.length > 0) return true;
  }
  return false;
};

const outcomeOf = (degraded: string | null, intentsExamined: number): BootReport['outcome'] => {
  if (degraded !== null) return 'recovered';
  return intentsExamined > 0 ? 'reconciled' : 'clean';
};

/** Projection watermark capture (max over views, -1 when no views registered). */
const maxWatermark = (status: {
  views: readonly { watermarks: readonly { seq: number }[] }[];
}): number => {
  let max = -1;
  for (const view of status.views) {
    for (const wm of view.watermarks) max = Math.max(max, wm.seq);
  }
  return max;
};

/**
 * EES §2.13 boot reconcile. `signal` is the crash-marker verdict for this wake
 * (E2-T07 — an explicit INPUT, never probed here): the report embeds it with
 * the §14.4/R16 copy path computed against this report's own lossRisk, so the
 * card-gating law has exactly one evaluation site.
 */
export const reconcileBoot = async (
  deps: ReconcilerDeps,
  signal: BootSignal,
): Promise<Result<BootReport, LedgeError>> => {
  const bootTs = deps.now();
  const gaps: string[] = [];
  const scratch: ResolutionScratch = { coveredOnce: 0, doubleCountPrevented: 0 };
  let degraded: string | null = null;

  // (1) integrity probe — the tail seal/CRC verdict gates every later write.
  const probe = await deps.journal.scanTail();
  const probeReport: JournalProbeReport = probe.ok
    ? {
        ok: true,
        durableThrough:
          probe.value.devices.find((d) => d.deviceId === deps.deviceId)?.durableThrough ?? 0,
      }
    : { ok: false, durableThrough: 0, errorCode: probe.error.code };
  if (!probe.ok) {
    degraded = 'journal-probe-failed';
    gaps.push(`integrity-probe:${probe.error.code}`);
  }

  // (2) evidence scan (skipped on degraded probe: acting on unverified truth is
  // exactly what the conservative law forbids).
  let evidence: DeviceEvidence | null = null;
  if (degraded === null) {
    const scanned = await scanDeviceEvidence(deps.journal, deps.deviceId);
    if (!scanned.ok) {
      degraded = 'evidence-scan-failed';
      gaps.push(`evidence-scan:${scanned.error.code}`);
    } else {
      evidence = scanned.value;
      if (scanned.value.preservedUnknown > 0) {
        gaps.push(`preserved-unknown-rows:${scanned.value.preservedUnknown}`);
      }
    }
  }

  // (3) dangling scan + per-intent resolution (deterministic order).
  const resolutions: IntentResolution[] = [];
  if (degraded === null && evidence !== null) {
    const pending = await deps.ledger.pending();
    if (!pending.ok) {
      degraded = 'pending-scan-failed';
      gaps.push(`pending-scan:${pending.error.code}`);
    } else {
      const maxLamport = evidence.maxLamport;
      const durableThrough = evidence.durableThrough;
      const state: StampState = {
        cursor: {
          seq: durableThrough,
          lamport: maxLamport,
          deviceId: deps.deviceId,
          wallClock: 0,
        },
      };
      const ordered = [...pending.value].sort(
        (a, b) => a.issuedAt - b.issuedAt || (a.intentId < b.intentId ? -1 : 1),
      );
      for (const record of ordered) {
        const resolution = await resolveIntent(
          record,
          evidence,
          policyFor(record.kind),
          state,
          deps,
          scratch,
        );
        resolutions.push(resolution);
        if (resolution.errorCode !== undefined) {
          gaps.push(`resolution-write:${record.intentId}:${resolution.errorCode}`);
        }
      }
    }
  }

  // (4) projections catch-up — only on a healthy probe (watermarks move forward
  // only by law; a dirty boot may not advance read models).
  let projectionsReport: ProjectionsBootReport | null = null;
  if (deps.projections !== undefined && degraded === null) {
    const before = await deps.projections.status();
    if (!before.ok) {
      gaps.push(`projection-status:${before.error.code}`);
      projectionsReport = {
        applied: 0,
        watermarkFrom: -1,
        watermarkTo: -1,
        errorCode: before.error.code,
      };
    } else {
      const applied = await deps.projections.applyFromJournal(deps.deviceId);
      const after = await deps.projections.status();
      if (!applied.ok || !after.ok) {
        const code = !applied.ok ? applied.error.code : after.ok ? 'unknown' : after.error.code;
        gaps.push(`projection-catchup:${code}`);
        projectionsReport = {
          applied: 0,
          watermarkFrom: maxWatermark(before.value),
          watermarkTo: -1,
          errorCode: code,
        };
      } else {
        projectionsReport = {
          applied: applied.value.applied,
          watermarkFrom: maxWatermark(before.value),
          watermarkTo: maxWatermark(after.value),
        };
      }
    }
  } else if (deps.projections === undefined) {
    gaps.push('projections-unavailable');
  }

  // (5) sessions cross-check — degraded-unavailable is the sanctioned v1 posture.
  let crossCheck: BootReport['crossCheck'] = 'degraded-unavailable';
  if (deps.crossCheck !== undefined) {
    const candidates = await deps.crossCheck();
    if (candidates.ok) {
      crossCheck = 'applied';
    } else {
      gaps.push(`cross-check:${candidates.error.code}`);
    }
  } else {
    gaps.push('sessions-crosscheck-unavailable');
  }

  // The probe row in the report carries the freshest durable boundary we verified;
  // a degraded boot keeps the probe verdict visible even when later steps were
  // suppressed (lossRisk then also reads the degraded flag below).
  const finalProbe: JournalProbeReport =
    degraded === null && evidence !== null
      ? { ok: true, durableThrough: evidence.durableThrough }
      : probeReport;

  const lossRisk = degraded !== null || assessLossRisk(finalProbe, resolutions);
  const report: BootReport = {
    schemaV: RECONCILE_REPORT_SCHEMA_V,
    deviceId: deps.deviceId,
    bootTs,
    outcome: outcomeOf(degraded, resolutions.length),
    bootSignal: { ...signal, copyKey: copyKeyFor(signal.cause, lossRisk) },
    // §14.4: degraded boots are loss-risk by definition (scope unknown).
    lossRisk,
    journalProbe: finalProbe,
    intentsExamined: resolutions.length,
    resolutions,
    evidence: {
      coveredOnce: scratch.coveredOnce,
      doubleCountPrevented: scratch.doubleCountPrevented,
    },
    projections: projectionsReport,
    crossCheck,
    gaps,
  };
  return ok(report);
};
