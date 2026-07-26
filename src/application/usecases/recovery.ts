// E6-T01 · W7 recovery service — the application half of Blueprint §5.9 (recovery
// path) and the §14.4 card-gating venue. Three acts:
//
//   recordBoot(report)    — the boot hook's deposit: persist the BootReport to the
//      meta incident slot (single-slot latest, EES §5 meta key→value), decide the
//      §14.4/R16 announce fact (abnormal marker causes announce; warm/first-run/
//      undetectable stay silent — Marker taxonomy law: "no copy path ever" for
//      warm), and answer the slot state the root announces/opens the card for.
//      Merge law: a pending (unrestored) incident is NEVER clobbered by a
//      non-incident report (a warm recycle must not hide the user's unrestored
//      crash); any new incident supersedes, and a settled slot retires on the
//      next boot fact so the guardian chip doesn't nag forever.
//   getBootReport({id?})  — the GetBootReport query: id-less = latest announced
//      incident slot (the auto-opened quiet tab can land after the fire-and-
//      forget stream); explicit id = card-on-demand. DTO scope is TRUTH-NOW:
//      current live rows the put-back would restore, not a boot-time snapshot.
//   restoreBootSession    — §5.9 "Put everything back → Resume intents per
//      mission": server-side per-mission expansion (authority-free surfaces
//      cannot enumerate). Durable claim first (restoringCid — crash/concurrency
//      guard), ResumeAccepted BEFORE each browser move (§6.5 ack band), then the
//      MissionResumed stamp with the actual mapping. decideResume is NOT called:
//      crash-correction is not a lifecycle transition (missions stay 'live'; the
//      domain law governs state changes, and none occur — Blueprint §6.7).
//      Settle law: zero failures settles the slot; any failure leaves it pending
//      (retry is lawful and idempotent per-mission via the open-check).
//
//   E6-T02 cross-check candidates (adr note: docs/adr-notes/e6-recovery-crosscheck.md):
//      F1 unmatched-only — candidates are the browser's Recently Closed backlog rows
//      whose URL matches NO journal live-scope row (a match silently confirms scope).
//      F3 snapshot law — the set is computed ONCE, at incident creation inside
//      recordBoot, stored on the slot (≤ MAX_CROSSCHECK_CANDIDATES), and NEVER
//      mutated afterward: the card always shows what that boot observed; later
//      boots create new incidents rather than rewriting this one. F2 extend-
//      restore — restoreBootSession accepts additive-optional `includeCandidates`
//      (confirm-before-restore: the surface toggles rows in, nothing restores
//      implicitly) and opens them as plain new tabs in ONE trailing window,
//      never mission-formed; only snapshotted URLs are lawful picks (authority-
//      free surfaces are never trusted), deduped against what the act reopened.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type {
  BootReportInput,
  BootResolutionInput,
} from '@/application/ports/recovery-boot.port.js';
import type { RecentlyClosedTab } from '@/application/ports/sessions.port.js';
import type { BootReportDisclosure, BootReportView } from '@/application/dto/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import { missionStateOf, readMeta, readMission, readTab } from './shared/rows.js';
import type { PlannedPlan } from './shared/stream-appender.js';

/** Meta incident-slot key (EES §5 meta key→value shelf; no new store — schema v1). */
export const META_BOOT_REPORT_KEY = 'bootReport.latest';
/** Slot value schema covenant (report schema v1 rides inside; EES §2.13). */
export const BOOT_SLOT_SCHEMA_V = 1;

const RESTORE_OP = 'command:RestoreBootSession';
const URL_KEY = 'url';
const GRACE_PROGRESS_STAGES = 4;
/** Platform backlog ceiling (EES §2.13 step 5) — snapshot storage bound + the
 *  includeCandidates legality ceiling. */
export const MAX_CROSSCHECK_CANDIDATES = 25;

export type BootSeverity = 'loss-risk' | 'clean-abnormal';

/** The incident slot as persisted at META_BOOT_REPORT_KEY (value side of {key,value}). */
export interface BootReportSlot {
  readonly schemaV: typeof BOOT_SLOT_SCHEMA_V;
  readonly bootReportId: string;
  readonly recordedAt: number;
  readonly report: BootReportInput;
  readonly announced: boolean;
  readonly severity: BootSeverity | null;
  readonly settledAt: number | null;
  /** Durable restore claim (cid of the in-flight put-back; null when idle). */
  readonly restoringCid: string | null;
  /** E6-T02 F3: boot-time cross-check candidate snapshot (immutable; additive-
   *  optional so the slot schema stays v1 — bumping V would orphan a pending
   *  unrestored incident under the forward-tolerance-absent read law). */
  readonly candidates?: readonly RecentlyClosedTab[] | undefined;
}

export interface RecordBootAnswer {
  readonly bootReportId: string;
  /** true ⟺ the root should publish recovery-available (one bus fact per incident). */
  readonly announce: boolean;
  readonly severity: BootSeverity | null;
  /** true ⟺ §14.4 card gate: severity loss-risk AND still pending after this record. */
  readonly cardWanted: boolean;
}

export interface RestoreOutcome {
  readonly missionsRestored: number;
  readonly tabsRestored: number;
  readonly disclosure: readonly string[];
  /** E6-T02 F2: candidate tabs actually opened (present ⟺ the request carried
   *  includeCandidates — a symmetric answer even when every pick was deduped). */
  readonly candidatesRestored?: number | undefined;
}

export interface RecoveryService {
  recordBoot(report: BootReportInput): Promise<Result<RecordBootAnswer, LedgeError>>;
  getBootReport(input: {
    readonly bootReportId?: string | undefined;
  }): Promise<Result<BootReportView | null, LedgeError>>;
  restoreBootSession(
    input: {
      readonly bootReportId: string;
      /** E6-T02 F2: confirmed candidate URLs from the panel's toggles. */
      readonly includeCandidates?: readonly string[] | undefined;
    },
    ctx: UseCtx,
  ): Promise<Result<RestoreOutcome, LedgeError>>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const readSlot = async (
  engine: ServiceEdge['deps']['engine'],
): Promise<Result<BootReportSlot | undefined, LedgeError>> => {
  const value = await readMeta(engine, META_BOOT_REPORT_KEY);
  if (!value.ok) return err(value.error);
  if (value.value === undefined) return ok(undefined);
  const v = value.value as Partial<BootReportSlot>;
  // Forward-tolerance (§2.9): a slot that fails shape is treated ABSENT — the next
  // record re-establishes it; a report fetch answers null rather than crashing.
  if (v.schemaV !== BOOT_SLOT_SCHEMA_V || typeof v.bootReportId !== 'string') return ok(undefined);
  const candidates = storedCandidatesOf(v.candidates);
  return ok({ ...(v as BootReportSlot), ...(candidates !== undefined ? { candidates } : {}) });
};

/** E6-T02: sanitize the additive-optional snapshot field — malformed rows are
 *  dropped (§2.9 read-side degrade), a present-but-empty set stays a snapshot. */
const storedCandidatesOf = (v: unknown): readonly RecentlyClosedTab[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: RecentlyClosedTab[] = [];
  for (const row of v as readonly unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const url = str((row as { readonly url?: unknown }).url);
    if (url.length === 0) continue;
    out.push({ url, title: str((row as { readonly title?: unknown }).title) });
  }
  return out;
};

// ── pure decisions (unit-law surfaces) ──────────────────────────────────────────

/** §14.4/R16 announce fact from the report's own marker signal. */
export const announceOf = (
  report: BootReportInput,
): { announce: boolean; severity: BootSeverity | null } => {
  if (!report.bootSignal.abnormal) return { announce: false, severity: null };
  return {
    announce: true,
    severity: report.lossRisk ? 'loss-risk' : 'clean-abnormal',
  };
};

/** Merge law: may this fresh report overwrite the slot? */
export const overwriteLaw = (
  slot: BootReportSlot | undefined,
  report: BootReportInput,
): boolean => {
  if (slot === undefined) return true;
  if (report.bootSignal.abnormal) return true; // a new incident supersedes
  return slot.settledAt !== null; // settled incidents retire on any new boot fact
};

/** Disclosure receipts (stable tokens + counts) — the catalog renders them. */
export const disclosureOf = (
  report: BootReportInput,
  resolutions: readonly BootResolutionInput[],
): readonly BootReportDisclosure[] => {
  const out: BootReportDisclosure[] = [];
  if (report.outcome === 'recovered') out.push({ token: 'journal-truncate', count: 1 });
  let leftOpen = 0;
  let deferred = 0;
  for (const r of resolutions) {
    if (r.disposition === 'aborted-conservative') leftOpen += 1;
    if (r.disposition === 'deferred') deferred += 1;
  }
  if (leftOpen > 0) out.push({ token: 'left-open', count: leftOpen });
  if (deferred > 0) out.push({ token: 'deferred', count: deferred });
  if (report.crossCheck === 'degraded-unavailable')
    out.push({ token: 'crosscheck-degraded', count: 1 });
  if (report.bootSignal.gaps.length > 0 || report.gaps.length > 0)
    out.push({ token: 'marker-gap', count: report.bootSignal.gaps.length + report.gaps.length });
  return out;
};

/**
 * E6-T02 F1 (unmatched-only): the Recently Closed backlog minus every URL the
 * journal's live scope already accounts for — a match silently confirms scope.
 * Dedupe by URL keep-first (backlog arrives most-recent-first), capped at the
 * platform ceiling so the slot snapshot stays bounded.
 */
export const crossCheckCandidatesOf = (
  backlog: readonly RecentlyClosedTab[],
  scopeUrls: readonly string[],
): readonly RecentlyClosedTab[] => {
  const scoped = new Set(scopeUrls);
  const seen = new Set<string>();
  const out: RecentlyClosedTab[] = [];
  for (const row of backlog) {
    if (row.url.length === 0 || scoped.has(row.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push({ url: row.url, title: row.title });
    if (out.length >= MAX_CROSSCHECK_CANDIDATES) break;
  }
  return out;
};

export const createRecoveryService = (edge: ServiceEdge): RecoveryService => {
  const { deps, appender } = edge;

  const writeSlot = async (slot: BootReportSlot): Promise<Result<void, LedgeError>> => {
    const r = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
      await tx.table('meta').put({ key: META_BOOT_REPORT_KEY, value: slot });
    });
    return r.ok ? ok(undefined) : err(r.error);
  };

  /** TRUTH-NOW live inventory: the rows a put-back would actually reopen. */
  const liveScope = async (): Promise<
    Result<
      { rows: readonly StoredRecord[]; tabs: number; missions: number; asOf: number },
      LedgeError
    >
  > => {
    const r = await deps.engine.txn(['tabs'], 'readonly', async (tx) =>
      tx.table<StoredRecord>('tabs').byIndex({ kind: 'equals', name: 'state', value: 'live' }),
    );
    if (!r.ok) return err(r.error);
    // Scope ≡ the put-back set (§5.9 per-mission Resume): restorable members only —
    // the card's counts and the restore's act can never disagree.
    const restorable = r.value.filter(
      (row) => str(row[URL_KEY]).length > 0 && str(row['missionId']).length > 0,
    );
    const missions = new Set<string>();
    let asOf = 0;
    for (const row of restorable) {
      missions.add(str(row['missionId']));
      asOf = Math.max(asOf, num(row['lastActiveAt']));
    }
    return ok({
      rows: restorable,
      tabs: restorable.length,
      missions: missions.size,
      asOf,
    });
  };

  /**
   * E6-T02 F3: the ONE-AND-ONLY candidate computation — incident creation, never
   * again. Every failure path degrades to ABSENT (no snapshot key): the boot act
   * must never fault on a cross-check seam, and the report's crossCheck token
   * already discloses a degraded seam.
   */
  const candidatesSnapshot = async (): Promise<readonly RecentlyClosedTab[] | undefined> => {
    if (deps.sessions === undefined) return undefined;
    const scope = await liveScope();
    if (!scope.ok) return undefined;
    const backlog = await deps.sessions.recentlyClosedTabs();
    if (!backlog.ok) return undefined;
    return crossCheckCandidatesOf(
      backlog.value,
      scope.value.rows.map((row) => str(row[URL_KEY])),
    );
  };

  const toView = (
    slot: BootReportSlot,
    scope: { tabs: number; missions: number; asOf: number },
  ): BootReportView => ({
    bootReportId: slot.bootReportId,
    severity: slot.severity ?? 'clean-abnormal',
    cause: slot.report.bootSignal.cause,
    copyKey: slot.report.bootSignal.copyKey,
    outcome: slot.report.outcome,
    asOf: scope.asOf > 0 ? scope.asOf : slot.report.bootTs,
    scope: { tabsRecoverable: scope.tabs, missionsAffected: scope.missions },
    crossCheck: slot.report.crossCheck,
    ...(slot.candidates !== undefined ? { crossCheckCandidates: slot.candidates } : {}),
    disclosure: disclosureOf(slot.report, slot.report.resolutions),
    pending: slot.severity === 'loss-risk' && slot.settledAt === null,
    restoredAt: slot.settledAt,
  });

  const legalityRefusal = (reason: string): Promise<Result<never, LedgeError>> =>
    Promise.resolve(err(ledgeError('E_DOMAIN_LEGALITY', { operation: RESTORE_OP, reason })));

  return {
    recordBoot: async (report) => {
      const slot = await readSlot(deps.engine);
      if (!slot.ok) return err(slot.error);
      if (!overwriteLaw(slot.value, report)) {
        // The pending incident stands; answer the SLOT's announce facts (the warm
        // report that lost the merge is a non-event by marker law).
        const keep = slot.value;
        if (keep === undefined)
          return err(ledgeError('E_CORRUPT_STORE', { what: 'boot-slot-merge', field: 'value' }));
        return ok({
          bootReportId: keep.bootReportId,
          announce: false,
          severity: keep.severity,
          cardWanted: keep.severity === 'loss-risk' && keep.settledAt === null,
        });
      }
      const gate = announceOf(report);
      // E6-T02 F3 snapshot law: compute the candidate set exactly once — here, at
      // incident creation. Non-incident slots take none (no card path exists).
      const candidates = gate.announce ? await candidatesSnapshot() : undefined;
      const fresh: BootReportSlot = {
        schemaV: BOOT_SLOT_SCHEMA_V,
        bootReportId: deps.ids.nextId(),
        recordedAt: deps.now(),
        report,
        announced: gate.announce,
        severity: gate.severity,
        settledAt: null,
        restoringCid: null,
        ...(candidates !== undefined ? { candidates } : {}),
      };
      const wrote = await writeSlot(fresh);
      if (!wrote.ok) return err(wrote.error);
      return ok({
        bootReportId: fresh.bootReportId,
        announce: fresh.announced,
        severity: fresh.severity,
        cardWanted: fresh.severity === 'loss-risk',
      });
    },

    getBootReport: async (input) => {
      const slot = await readSlot(deps.engine);
      if (!slot.ok) return err(slot.error);
      const current = slot.value;
      if (current === undefined || !current.announced) {
        // View law: the DTO exists for ANNOUNCED incidents only. Non-incident
        // slots (warm/clean boots) carry no copy path — surfaces stay silent on
        // both the id-less and the demand path.
        return ok(null);
      }
      if (input.bootReportId !== undefined && current.bootReportId !== input.bootReportId)
        return ok(null);
      const scope = await liveScope();
      if (!scope.ok) return err(scope.error);
      return ok(
        toView(current, {
          tabs: scope.value.tabs,
          missions: scope.value.missions,
          asOf: scope.value.asOf,
        }),
      );
    },

    restoreBootSession: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      ctx.progress({ stage: 1 });
      const slot = await readSlot(deps.engine);
      if (!slot.ok) return err(slot.error);
      const current = slot.value;
      if (current === undefined) return legalityRefusal('boot-report-missing');
      if (current.bootReportId !== input.bootReportId) return legalityRefusal('boot-report-stale');
      if (current.settledAt !== null) {
        // C7-class resend law: a settled put-back answers the idempotent zero.
        return ok({ missionsRestored: 0, tabsRestored: 0, disclosure: ['already-restored'] });
      }
      if (!current.announced) return legalityRefusal('nothing-to-restore');
      if (current.restoringCid !== null) return legalityRefusal('restore-in-flight');
      // E6-T02 F2 legality (decided before ANY browser move): bounded, non-empty
      // strings only — over-limit or malformed payloads refuse, never truncate.
      const requested = input.includeCandidates;
      if (requested !== undefined) {
        if (requested.length > MAX_CROSSCHECK_CANDIDATES)
          return legalityRefusal('candidates-over-limit');
        if (requested.some((u) => u.length === 0)) return legalityRefusal('candidates-invalid');
      }

      // Durable claim BEFORE any browser move: a crash/concurrent caller finds the
      // stamp and refuses instead of double-opening windows (§6.5 band discipline).
      const claimed = await writeSlot({ ...current, restoringCid: ctx.cid });
      if (!claimed.ok) return err(claimed.error);

      ctx.progress({ stage: 2 });
      const scope = await liveScope();
      if (!scope.ok) return err(scope.error);

      // Recency-first: the mission you touched last comes back first.
      const byMission = new Map<
        string,
        { row?: StoredRecord; tabs: StoredRecord[]; last: number }
      >();
      for (const tab of scope.value.rows) {
        const missionId = str(tab['missionId']);
        const bucket = byMission.get(missionId) ?? { tabs: [], last: 0 };
        bucket.tabs.push(tab);
        bucket.last = Math.max(bucket.last, num(tab['lastActiveAt']));
        byMission.set(missionId, bucket);
      }
      const ordered = [...byMission.entries()].sort((a, b) => b[1].last - a[1].last);

      const disclosure = new Set<string>();
      let missionsRestored = 0;
      let tabsRestored = 0;
      let failures = 0;
      let firstWindow = true;
      // URLs this act already reopened — candidate picks dedupe against them.
      const reopenedUrls = new Set<string>();

      for (const [missionId, bucket] of ordered) {
        ctx.token.throwIfCancelled();
        const mission = await readMission(deps.engine, missionId);
        if (!mission.ok) {
          failures += 1;
          disclosure.add('restore-failed');
          continue;
        }
        const row = mission.value;
        if (row === undefined || missionStateOf(row) === 'trash') {
          disclosure.add('mission-gone');
          continue;
        }
        // Open-check (C7 resend law, browser reality variant): the mission's recorded
        // window still holding live tabs ⇒ already back; never double-open.
        const binding = row['windowBinding'];
        if (typeof binding === 'number') {
          const openNow = await deps.tabs.query({ windowId: binding });
          if (openNow.ok && openNow.value.length > 0) {
            disclosure.add('already-open');
            continue;
          }
        }
        const plans: { tabId: string; url: string }[] = [];
        for (const tab of bucket.tabs) {
          const tabId = str(tab['ledgeTabId']);
          const content = await readTab(deps.engine, tabId);
          if (!content.ok) {
            failures += 1;
            disclosure.add('restore-failed');
            continue;
          }
          const url = str(content.value?.[URL_KEY]);
          if (url.length === 0) {
            disclosure.add('no-content');
            continue;
          }
          plans.push({ tabId, url });
        }
        if (plans.length === 0) continue;

        // §6.5 ack band: durable accept BEFORE the browser mutation.
        const accepted = await appender.commit({
          plans: [
            {
              type: 'ResumeAccepted',
              payload: {
                missionId,
                mode: 'full',
                restoredMapping: { plannedTabIds: plans.map((t) => t.tabId) },
              },
            } satisfies PlannedPlan,
          ],
          key: opKey(edge, 'RestoreBootSession:accept', ctx.cid),
        });
        if (!accepted.ok) {
          failures += 1;
          disclosure.add('restore-failed');
          continue;
        }
        ctx.notifyPending(`RestoreBootSession:${missionId}`);

        const created = await deps.windows.create({
          tabSpecs: plans.map((t) => ({ url: t.url })),
          focused: firstWindow, // one focused window per put-back; the rest arrive calm
        });
        firstWindow = false;
        if (!created.ok) {
          failures += 1;
          disclosure.add('restore-failed');
          continue;
        }
        const windowId = created.value;
        const tabsNow = await deps.tabs.query({ windowId });
        const browserIds = tabsNow.ok ? tabsNow.value.map((t) => t.browserTabId) : [];
        const completed = await appender.commit({
          plans: [
            {
              type: 'MissionResumed',
              payload: {
                missionId,
                mode: 'full',
                restoredMapping: {
                  windowId,
                  tabs: plans.map((t, i) => ({
                    tabId: t.tabId,
                    ...(browserIds[i] !== undefined ? { browserTabId: browserIds[i] } : {}),
                  })),
                },
              },
            } satisfies PlannedPlan,
          ],
          key: opKey(edge, 'RestoreBootSession:complete', ctx.cid),
        });
        if (!completed.ok) {
          failures += 1;
          disclosure.add('restore-failed');
          continue;
        }
        missionsRestored += 1;
        tabsRestored += plans.length;
        for (const plan of plans) reopenedUrls.add(plan.url);
      }

      // E6-T02 F2 (extend-restore): confirmed candidates open as PLAIN tabs in ONE
      // trailing window — never mission-formed, only when the request asked; law:
      //   · snapshotted URLs only (authority-free surfaces are never trusted);
      //   · deduped against anything this act already reopened;
      //   · focused ONLY when no mission window preceded it (never steal the
      //     current browsing focus — same calm-arrival rule as the mission loop);
      //   · a browser failure discloses and keeps the incident pending (retry ok).
      let candidatesRestored: number | undefined;
      if (requested !== undefined) {
        candidatesRestored = 0;
        const snapshotUrls = new Set((current.candidates ?? []).map((c) => c.url));
        const picks: string[] = [];
        for (const url of requested) {
          if (!snapshotUrls.has(url) || reopenedUrls.has(url) || picks.includes(url)) continue;
          picks.push(url);
        }
        if (picks.length > 0) {
          const opened = await deps.windows.create({
            tabSpecs: picks.map((url) => ({ url })),
            focused: firstWindow,
          });
          if (!opened.ok) {
            failures += 1;
            disclosure.add('restore-failed');
          } else {
            firstWindow = false;
            candidatesRestored = picks.length;
          }
        }
      }

      ctx.progress({ stage: 3 });
      // Settle law: zero failures retires the incident; any failure keeps it
      // pending — the card's retry is lawful and idempotent per-mission.
      const finished: BootReportSlot = {
        ...current,
        restoringCid: null,
        settledAt: failures === 0 ? deps.now() : null,
      };
      const settledWrite = await writeSlot(finished);
      if (!settledWrite.ok) return err(settledWrite.error);
      ctx.progress({ stage: GRACE_PROGRESS_STAGES });
      if (missionsRestored === 0 && failures === 0) disclosure.add('nothing-live');
      return ok({
        missionsRestored,
        tabsRestored,
        disclosure: [...disclosure].sort(),
        ...(candidatesRestored !== undefined ? { candidatesRestored } : {}),
      });
    },
  };
};
