// E8-T08 · domain/lifecycle — sprawl evidence law (Spec §6.10 inputs: "strip
// pressure", v1 scope; roadmap completion: "R15 bucket semantics fixtures").
// Pure and total: tabs in, the stale cohort out. Laws this module keeps:
//  * EVIDENCE, NOT PSYCHICS: staleness is a FACT (lastActiveAt older than the
//    stale age) — never a prediction, never a score. §6.10's rhythms and
//    dormancy inputs are later milestones; v1 is strip pressure alone.
//  * THE SPEC'S OWN NUMBER: the offer threshold (SPRAWL_MIN_STALE_COUNT) is
//    the spec's example count ("6 tabs from last week's visa research") —
//    a smaller cohort is per-tab noise not worth a whisper (errs to never).
//  * HONEST ORDER: the cohort answers oldest-first — the stal-est evidence
//    leads, and a park-loop retires it in that order.
//  * NOTHING HERE ACTS: this module counts. Only an explicit tap turns a
//    cohort into parks (the opt-in law, downstream).

/** One live tab's evidence slice (rows are validated at the boundary). */
export interface SprawlTabEvidence {
  readonly ledgeTabId: string;
  readonly browserTabId: number;
  readonly title: string;
  readonly domain: string;
  readonly lastActiveAt: number;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_STALE = 7;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** A tab untouched this long is "from last week" (Spec §6.10 phrasing). */
export const SPRAWL_STALE_AGE_MS = DAYS_STALE * DAY_MS;

/** Fewer stale tabs than this and the timing model stays silent. */
export const SPRAWL_MIN_STALE_COUNT = 6;

/**
 * The stale cohort: live tabs whose lastActiveAt predates `now - staleAge`,
 * oldest-first (ties by ledgeTabId — deterministic, never random). Rows with
 * unusable recency (lastActiveAt ≤ 0) are un-knowable evidence and excluded:
 * a nudge must never claim age it cannot show.
 */
export const sprawlStaleTabs = (
  tabs: readonly SprawlTabEvidence[],
  now: number,
  staleAge: number = SPRAWL_STALE_AGE_MS,
): readonly SprawlTabEvidence[] => {
  const cutoff = now - staleAge;
  return tabs
    .filter((t) => t.lastActiveAt > 0 && t.lastActiveAt < cutoff)
    .map((t) => ({ ...t }))
    .sort((a, b) =>
      a.lastActiveAt !== b.lastActiveAt
        ? a.lastActiveAt - b.lastActiveAt
        : a.ledgeTabId.localeCompare(b.ledgeTabId),
    );
};

/** The offer law: a whisper needs at least the spec-numbered cohort. */
export const sprawlOfferable = (cohortSize: number): boolean =>
  cohortSize >= SPRAWL_MIN_STALE_COUNT;
