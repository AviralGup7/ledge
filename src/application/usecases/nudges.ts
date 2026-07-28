// E8-T08 · Sprawl nudge use-case — the one-a-day whisper (Spec §5.8: "one
// optional tab-sprawl nudge/day (opt-out; three dismissals = never again per
// type)"; §6.10: "timing model errs to never"; EES-R15: meta bucket law).
// Laws this service keeps:
//  * SILENCE IS THE DEFAULT STATE: every gate (switches, dismissal memory,
//    day cap, evidence floor) answers absence, and a failed offer consumes
//    the day's slot rather than double-speaking (errs to never, literally).
//  * THE DAY IS THE DEVICE'S DAY: the bucket is the host-clock local-midnight
//    floor (R15) — injected minutes offset, never a Date read here; timezone
//    changes lengthen/shorten one day with no correction logic.
//  * OFFER FACTS ARE JOURNAL TRUTH, COUNTERS ARE META (R15): NudgeOffered is
//    the append-only audit that the surface spoke (M7-WP3); the day bucket
//    and dismissal counter-pair are meta rows — cheap, LWW-merging, exactly
//    the model R15 freezes. No NudgeDismissed event: dismissal memory IS the
//    counter-pair; a count is not a story (contrast BriefDismissed's J4).
//  * STICKY WITHIN THE DAY: once offered, later reads return the SAME offer
//    while evidence stands (a re-render is the same whisper, not a new one).
//    Dismissal outranks stickiness (the user already answered).
//  * ACT-ON-NOW + CONVERGENT: acting re-derives the stale cohort from a
//    fresh read; already-parked rows (E_NOT_FOUND_TAB) count as converged.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { SprawlTabEvidence } from '@/domain/lifecycle/index.js';
import { sprawlOfferable, sprawlStaleTabs } from '@/domain/lifecycle/index.js';
import type { NudgeDismissalMemory } from '@/domain/memory/index.js';
import { localMidnightFloor, nudgeWindow } from '@/domain/memory/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import { readLiveTabs, readMeta, readSettingsRows } from './shared/rows.js';

const NUDGES_OP = 'command:nudges';

/** The single nudge type v1 speaks (per-type dismissal memory keys on it). */
export const NUDGE_TYPE_SPRAWL = 'sprawl';

/** R15 meta rows: day-bucket counters (`nudge.day.<localMidnightEpoch>`). */
export const META_NUDGE_DAY_PREFIX = 'nudge.day.';
/** R15 dismissal counter-pairs (`nudge.dismiss.<nudgeType>`). */
export const META_NUDGE_DISMISS_PREFIX = 'nudge.dismiss.';

/** Spec §6.10 control: the one global "no suggestions" switch (opt-OUT —
 *  default allowed; crash-recovery is a promise, not a suggestion, and never
 *  reads this). §12.1 per-capability toggle for the nudge class. */
export const SETTING_SUGGESTIONS_ALL = 'prefs.suggestions.all';
export const SETTING_SUGGESTIONS_NUDGES = 'prefs.suggestions.nudges';

/** The offer the surface renders (offerId pins stickiness + act correlation). */
export interface SprawlNudgeOffer {
  readonly offerId: string;
  readonly nudgeType: typeof NUDGE_TYPE_SPRAWL;
  readonly staleCount: number;
  readonly dayBucket: number;
}

/** The park seam (composition injects the flagship park service). */
export interface NudgesParkSeam {
  readonly parkTab: (
    input: { readonly browserTabId: number },
    ctx: UseCtx,
  ) => Promise<Result<{ readonly kept: string }, LedgeError>>;
}

/** The host clock's offset semantics — production wires
 *  `-new Date().getTimezoneOffset()`; tests pin IST/UTC/retreat fixtures. */
export interface NudgesClockSeam {
  readonly offsetMinutes: () => number;
}

export interface NudgesService {
  /** The day's single offer, or null (absence is the default state). */
  pendingSprawlNudge(ctx: UseCtx): Promise<Result<SprawlNudgeOffer | null, LedgeError>>;
  /** ONE tap: park the re-derived stale cohort (parked honestly, converged calmly). */
  actOnSprawlNudge(
    input: { readonly offerId: string },
    ctx: UseCtx,
  ): Promise<Result<{ readonly parkedCount: number }, LedgeError>>;
  /** §6.10 misfire memory: +1 dismissal for the type (14-day ⇒ forever law). */
  dismissSprawlNudge(
    input: { readonly offerId: string },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
}

/** R15 day-row shape (one meta row per local day per device, LWW-carried). */
interface NudgeDayRow {
  readonly count: number;
  readonly offers?: { readonly sprawl?: SprawlNudgeOffer | undefined } | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const evidenceOf = (row: StoredRecord): SprawlTabEvidence | null => {
  const ledgeTabId = str(row['ledgeTabId']);
  const browserTabId = num(row['browserTabId']);
  if (ledgeTabId.length === 0 || browserTabId === undefined) return null;
  return {
    ledgeTabId,
    browserTabId,
    title: str(row['title']),
    domain: str(row['domain']),
    lastActiveAt: num(row['lastActiveAt']) ?? num(row['firstSeenAt']) ?? 0,
  };
};

const dayRowOf = (value: unknown): NudgeDayRow => {
  if (typeof value !== 'object' || value === null) return { count: 0 };
  const raw = value as Record<string, unknown>;
  const offersRaw = raw['offers'];
  const sprawlRaw =
    typeof offersRaw === 'object' && offersRaw !== null
      ? (offersRaw as Record<string, unknown>)['sprawl']
      : undefined;
  const sprawl: SprawlNudgeOffer | undefined =
    typeof sprawlRaw === 'object' && sprawlRaw !== null
      ? {
          offerId: str((sprawlRaw as Record<string, unknown>)['offerId']),
          nudgeType: NUDGE_TYPE_SPRAWL,
          staleCount: num((sprawlRaw as Record<string, unknown>)['staleCount']) ?? 0,
          dayBucket: num((sprawlRaw as Record<string, unknown>)['dayBucket']) ?? 0,
        }
      : undefined;
  return {
    count: num(raw['count']) ?? 0,
    ...(sprawl !== undefined && sprawl.offerId.length > 0 ? { offers: { sprawl } } : {}),
  };
};

const dismissalOf = (value: unknown): NudgeDismissalMemory | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return { count: num(raw['count']) ?? 0, lastDismissedAt: num(raw['lastDismissedAt']) ?? 0 };
};

const booleanSetting = (rows: readonly StoredRecord[], key: string): boolean | undefined => {
  const row = rows.find((r) => r['key'] === key);
  return typeof row?.['value'] === 'boolean' ? (row['value'] as boolean) : undefined;
};

export const createNudgesService = (
  edge: ServiceEdge,
  seams: NudgesParkSeam,
  clock: NudgesClockSeam,
): NudgesService => {
  const { deps, appender } = edge;
  const dismissKey = `${META_NUDGE_DISMISS_PREFIX}${NUDGE_TYPE_SPRAWL}`;

  const staleCohort = async (): Promise<Result<readonly SprawlTabEvidence[], LedgeError>> => {
    const live = await readLiveTabs(deps.engine);
    if (!live.ok) return err(live.error);
    const inputs = live.value.map(evidenceOf).filter((t): t is SprawlTabEvidence => t !== null);
    return ok(sprawlStaleTabs(inputs, deps.now()));
  };

  return {
    pendingSprawlNudge: async (ctx) => {
      ctx.token.throwIfCancelled();
      // Gate 1 — the control switches (§6.10/§12.1): explicit false mutes.
      const settings = await readSettingsRows(deps.engine);
      if (!settings.ok) return err(settings.error);
      if (
        booleanSetting(settings.value, SETTING_SUGGESTIONS_ALL) === false ||
        booleanSetting(settings.value, SETTING_SUGGESTIONS_NUDGES) === false
      ) {
        return ok(null);
      }
      const now = deps.now();
      const dayBucket = localMidnightFloor(now, clock.offsetMinutes());
      const dayKey = `${META_NUDGE_DAY_PREFIX}${dayBucket}`;
      // Gate 2 — dismissal memory + Gate 3 — the day cap (one timing decision).
      const [dayMeta, dismissMeta] = await Promise.all([
        readMeta(deps.engine, dayKey),
        readMeta(deps.engine, dismissKey),
      ]);
      if (!dayMeta.ok) return err(dayMeta.error);
      if (!dismissMeta.ok) return err(dismissMeta.error);
      const day = dayRowOf(dayMeta.value);
      const window = nudgeWindow({
        now,
        offeredTodayCount: day.count,
        dismissal: dismissalOf(dismissMeta.value),
      });
      if (window.kind === 'suppressed') {
        // Stickiness: only the DAY CAP may be outranked, and only by today's
        // own earlier offer (same whisper, re-rendered — never a new one).
        const prior = day.offers?.sprawl;
        if (window.reason !== 'daily-cap' || prior === undefined) return ok(null);
        const cohort = await staleCohort();
        if (!cohort.ok) return err(cohort.error);
        return sprawlOfferable(cohort.value.length) ? ok(prior) : ok(null);
      }
      // Gate 4 — evidence floor (the spec's own number).
      const cohort = await staleCohort();
      if (!cohort.ok) return err(cohort.error);
      if (!sprawlOfferable(cohort.value.length)) return ok(null);
      // The ONE offer of the day: meta first (a failed audit consumes the
      // slot rather than double-speaking — errs to never, mechanically).
      const offer: SprawlNudgeOffer = {
        offerId: deps.ids.nextId(),
        nudgeType: NUDGE_TYPE_SPRAWL,
        staleCount: cohort.value.length,
        dayBucket,
      };
      const stamped = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
        await tx.table('meta').put({
          key: dayKey,
          value: { count: day.count + 1, offers: { ...day.offers, sprawl: offer } },
        });
      });
      if (!stamped.ok) return err(stamped.error);
      const committed = await appender.commit({
        plans: [
          {
            type: 'NudgeOffered',
            payload: {
              nudgeOfferId: offer.offerId,
              nudgeType: NUDGE_TYPE_SPRAWL,
              dayBucket,
              staleCount: offer.staleCount,
              offeredAt: now,
            },
          },
        ],
        key: opKey(edge, 'NudgeOffer', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok(offer);
    },

    actOnSprawlNudge: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.offerId.trim().length === 0) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: NUDGES_OP, reason: 'offer-id-empty' }),
        );
      }
      // Act-on-now: the cohort is re-derived; an already-tidy strip converges
      // to "nothing left" (a redelivered tap parks nothing twice).
      const cohort = await staleCohort();
      if (!cohort.ok) return err(cohort.error);
      let parkedCount = 0;
      for (const [index, tab] of cohort.value.entries()) {
        ctx.token.throwIfCancelled(); // last checkpoint before each paid close
        const parked = await seams.parkTab(
          { browserTabId: tab.browserTabId },
          { ...ctx, cid: `${ctx.cid}:${index}` },
        );
        if (parked.ok) {
          parkedCount += 1;
          continue;
        }
        if (parked.error.code === 'E_NOT_FOUND_TAB') continue; // converged goal state
        return err(parked.error); // honest partial state; the surface re-pulls
      }
      return ok({ parkedCount });
    },

    dismissSprawlNudge: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.offerId.trim().length === 0) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: NUDGES_OP, reason: 'offer-id-empty' }),
        );
      }
      // R15 counter-pair, one row, read-modify-write inside the txn.
      const now = deps.now();
      const written = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
        const row = await tx.table<StoredRecord>('meta').get(dismissKey);
        const prior = dismissalOf(row?.['value']);
        await tx.table('meta').put({
          key: dismissKey,
          value: { count: (prior?.count ?? 0) + 1, lastDismissedAt: now },
        });
      });
      if (!written.ok) return err(written.error);
      return ok({});
    },
  };
};
