// E8-T08 · domain/memory — the nudge timing model (EES-R15 verbatim law:
// "counters in meta keyed by local-midnight bucket of device (timestamp
// floored), no cross-day carry; dismissal memory per nudgeType: 14-day
// suppression, third dismissal ⇒ forever (Spec §6.10 law). Timezone changes
// simply lengthen/shorten a day — no correction logic."). Pure and total:
// facts in, a window decision out. Laws this module keeps:
//  * ERRS TO NEVER (§6.10): every doubt answers 'suppressed'. The cap is one
//    offer per local day per DEVICE (no cross-day carry — yesterday's
//    silence does not bank today's whisper; R15).
//  * DAY = LOCAL MIDNIGHT OF THE DEVICE: the bucket key is the local-midnight
//    epoch floor the HOST computes (timezone lives with the host clock; this
//    module never reads Date). A timezone change simply lengthens or shortens
//    one day; nothing corrects, nothing migrates.
//  * DISMISSAL MEMORY IS TWO NUMBERS: {count, lastDismissedAt} per nudgeType
//    implements the §6.10 law exactly — any dismissal inside the window
//    suppresses; the third dismissal is forever. History beyond the latest
//    stamp is memory the gate never needs (R15 models it as a counter-pair).

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_OF_SUPPRESSION = 14;
const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MINUTE_MS;

/** §5.8/§6.10: at most ONE optional sprawl nudge per local day. */
export const NUDGE_DAILY_CAP = 1;

/** §6.10: a misfire (dismissal) suppresses that nudge-type for 14 days. */
export const NUDGE_DISMISS_SUPPRESS_MS = DAYS_OF_SUPPRESSION * DAY_MS;

/** §6.10: the third dismissal is forever, per nudge-type. */
export const NUDGE_DISMISS_FOREVER_COUNT = 3;

/** R15 counter-pair per nudgeType (meta-carried; LWW-merged rows converge). */
export interface NudgeDismissalMemory {
  readonly count: number;
  readonly lastDismissedAt: number;
}

export type NudgeWindowDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'suppressed';
      readonly reason: 'daily-cap' | 'dismissed-recently' | 'dismissed-forever';
    };

/**
 * The timing gate. Order of law: forever → recent-window → daily cap. All
 * inputs are already facts (the host floored the day; the store carried the
 * counter-pair); garbage counts (negative, NaN) read as their safest shape —
 * an unknown dismissal count reads as zero, an unknown last-stamp as "never".
 */
export const nudgeWindow = (args: {
  readonly now: number;
  readonly offeredTodayCount: number;
  readonly dismissal?: NudgeDismissalMemory | undefined;
}): NudgeWindowDecision => {
  const count =
    typeof args.dismissal?.count === 'number' && args.dismissal.count >= 0
      ? args.dismissal.count
      : 0;
  const last =
    typeof args.dismissal?.lastDismissedAt === 'number' ? args.dismissal.lastDismissedAt : 0;
  if (count >= NUDGE_DISMISS_FOREVER_COUNT) {
    return { kind: 'suppressed', reason: 'dismissed-forever' };
  }
  if (last > 0 && args.now - last < NUDGE_DISMISS_SUPPRESS_MS) {
    return { kind: 'suppressed', reason: 'dismissed-recently' };
  }
  if (args.offeredTodayCount >= NUDGE_DAILY_CAP) {
    return { kind: 'suppressed', reason: 'daily-cap' };
  }
  return { kind: 'allow' };
};

/**
 * R15 bucket math: the local-midnight epoch floor of `ts` under a fixed
 * offset (minutes, host-supplied — `new Date().getTimezoneOffset()` inverted).
 * Pure: the fixture lane pins IST/UTC/retreat boundaries against this.
 */
export const localMidnightFloor = (ts: number, offsetMinutes: number): number => {
  const shifted = ts + offsetMinutes * MINUTE_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS - offsetMinutes * MINUTE_MS;
};
