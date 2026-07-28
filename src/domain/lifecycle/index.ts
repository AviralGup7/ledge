// E3-APP · domain/lifecycle barrel (M2-WP1).
export type { MissionState, TabState, TrashableKind, SubjectSnapshot } from './states.js';
export type { LifecyclePolicy } from './policies/retention.js';
export { DEFAULT_LIFECYCLE_POLICY, policyOf, trashRetentionMsOf } from './policies/retention.js';
export type { DupeGroup, DupeGroupInput } from './policies/dupe-groups.js';
export {
  DUPE_GROUP_MIN_SIZE,
  DUPE_GROUP_STRIP_CAP,
  findDupeGroups,
} from './policies/dupe-groups.js';
export type { SprawlTabEvidence } from './policies/sprawl.js';
export {
  SPRAWL_MIN_STALE_COUNT,
  SPRAWL_STALE_AGE_MS,
  sprawlOfferable,
  sprawlStaleTabs,
} from './policies/sprawl.js';
export type { SwitcherClass, SwitcherMissionInput } from './policies/switcher.js';
export { switcherClassOf, switcherOrder } from './policies/switcher.js';
export type {
  Decision,
  InverseAtom,
  ParkPlanInput,
  PlannedEvent,
  PurgeSubject,
} from './transitions.js';
export {
  decideArchive,
  decideConclude,
  decideEmptyTrash,
  decideMerge,
  decideMove,
  decideParkPlan,
  decidePurgeSubject,
  decideRename,
  decideResume,
  decideSplit,
  decideTrash,
  decideTrashRestore,
  decideUndo,
} from './transitions.js';
