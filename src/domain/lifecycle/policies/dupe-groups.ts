// E8-T07 · domain/lifecycle — duplicate-group detection v2 (roadmap "Dupe
// detection v2 + actions": markers → one-tap actions under the OPT-IN law).
// Spec law this module keeps verbatim: the AI/features LANE "dedupes open
// duplicates (marks, does not close)" — detection is GROUPING + KEEP-PICK,
// never an action; the only closing vocabulary Ledge owns is parking, and it
// fires exclusively on an explicit user tap (application/wire law, proven by
// the action tests). Total, deterministic, projection-free: same rows in ⇒
// same groups out (redelivery and re-reads converge).
import { canonicalize } from '@/shared-kernel/canon/index.js';

/** One live tab as grouping input (the tabs-store projection slice — rows,
 *  never events; surfaces stay row-blind as usual). */
export interface DupeGroupInput {
  readonly ledgeTabId: string;
  readonly browserTabId: number;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly lastActiveAt: number;
}

/** A duplicate group, presentation-ready. `keep` is the PARK-EXEMPT member:
 *  the most recently active tab (ties break by ledgeTabId — total order),
 *  because surprise-closing the tab a user was just reading is exactly the
 *  silent-loss class the spec bans. `parkCandidates` are the older copies,
 *  most-recent first (the strip parks them in ONE tap, one lawful park each). */
export interface DupeGroup {
  readonly canonHash: string;
  readonly title: string;
  readonly domain: string;
  readonly keep: DupeGroupInput;
  readonly parkCandidates: readonly DupeGroupInput[];
}

/** Two identical canonical URLs are one group; singletons are not relief. */
export const DUPE_GROUP_MIN_SIZE = 2;
/** Strip posture: relief, not a report — more than this is a library smell,
 *  and the strip stays quiet (application may page later; the law caps here). */
export const DUPE_GROUP_STRIP_CAP = 5;

/** Total keep pick: max lastActiveAt, ties by lexicographic ledgeTabId. */
const pickKeep = (tabs: readonly DupeGroupInput[]): DupeGroupInput => {
  let keep = tabs[0];
  for (const tab of tabs) {
    if (keep === undefined) break;
    if (
      tab.lastActiveAt > keep.lastActiveAt ||
      (tab.lastActiveAt === keep.lastActiveAt && tab.ledgeTabId > keep.ledgeTabId)
    ) {
      keep = tab;
    }
  }
  if (keep === undefined) throw new Error('dupe-groups: empty keep pick');
  return keep;
};

/**
 * Group live tabs by canonical URL hash (the same canon rules ingest stamped
 * — grouping is re-derived, never stored, so a rules bump re-groups honestly
 * with zero migration). Ignored hashes (the strip's per-group dismiss
 * memory) are filtered HERE so callers can't forget the law.
 */
export const findDupeGroups = (
  tabs: readonly DupeGroupInput[],
  ignored?: ReadonlySet<string>,
): readonly DupeGroup[] => {
  const byHash = new Map<string, DupeGroupInput[]>();
  for (const tab of tabs) {
    if (tab.url.length === 0) continue; // ungroupable evidence — never invent a group
    const hash = canonicalize(tab.url).canonHash;
    if (ignored?.has(hash) === true) continue;
    const bucket = byHash.get(hash);
    if (bucket === undefined) byHash.set(hash, [tab]);
    else bucket.push(tab);
  }
  const groups: DupeGroup[] = [];
  for (const [canonHash, members] of byHash) {
    if (members.length < DUPE_GROUP_MIN_SIZE) continue;
    const keep = pickKeep(members);
    const parkCandidates = members
      .filter((t) => t.ledgeTabId !== keep.ledgeTabId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.ledgeTabId.localeCompare(b.ledgeTabId));
    const title = keep.title.length > 0 ? keep.title : keep.domain;
    groups.push({ canonHash, title, domain: keep.domain, keep, parkCandidates });
  }
  // Deterministic strip order: biggest relief first, hash-stable ties.
  return groups
    .sort(
      (a, b) =>
        b.parkCandidates.length - a.parkCandidates.length || a.canonHash.localeCompare(b.canonHash),
    )
    .slice(0, DUPE_GROUP_STRIP_CAP);
};
