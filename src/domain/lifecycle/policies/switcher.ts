// E8-T09 · domain/lifecycle — the switcher order law (Spec W8: "all missions,
// open first, parked next" — verbatim). Pure and total: mission rows in, the
// deterministic render order out. Laws this module keeps:
//  * THE SPEC ORDER IS THE ONLY ORDER: open contexts lead (they are one
//    focus away), parked contexts follow (they carry the chain cost), most
//    recently touched first inside each class — the mission the user was
//    just in is the least surprising default.
//  * EVERY CLASS IS ACCOUNTED FOR: 'live' ⇒ open; 'parked'/'archived' ⇒
//    parked (archived content still restores); 'trash', concluded or not,
//    anything unknown ⇒ excluded (the switcher never offers what resume
//    would refuse). Totality lives in the classifier, not at call sites.
//  * DETERMINISM: full ordering, ties by name then missionId — the switcher
//    is a door, not a slot machine.

/** The mission slice the order law reads (rows validated at the boundary). */
export interface SwitcherMissionInput {
  readonly missionId: string;
  readonly name: string;
  readonly state: string;
  readonly lastActiveAt: number;
}

export type SwitcherClass = 'open' | 'parked';

/** Totality: the render class of one mission, or null (never offered). */
export const switcherClassOf = (state: string): SwitcherClass | null => {
  if (state === 'live') return 'open';
  if (state === 'parked' || state === 'archived') return 'parked';
  return null; // trash/unknown: resume would refuse, so the door never shows
};

const byRecencyThenName = (a: SwitcherMissionInput, b: SwitcherMissionInput): number =>
  a.lastActiveAt !== b.lastActiveAt
    ? b.lastActiveAt - a.lastActiveAt
    : a.name !== b.name
      ? a.name.localeCompare(b.name)
      : a.missionId.localeCompare(b.missionId);

/**
 * The W8 order: open-first (hot recency), parked-next (hot recency), every
 * excluded class absent. Input rows are not mutated (copies out).
 */
export const switcherOrder = (
  missions: readonly SwitcherMissionInput[],
): readonly SwitcherMissionInput[] => {
  const open: SwitcherMissionInput[] = [];
  const parked: SwitcherMissionInput[] = [];
  for (const m of missions) {
    const cls = switcherClassOf(m.state);
    if (cls === 'open') open.push({ ...m });
    else if (cls === 'parked') parked.push({ ...m });
  }
  open.sort(byRecencyThenName);
  parked.sort(byRecencyThenName);
  return [...open, ...parked];
};
