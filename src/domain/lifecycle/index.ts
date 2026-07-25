// E3-APP · domain/lifecycle barrel (M2-WP1).
export type { MissionState, TabState, TrashableKind, SubjectSnapshot } from './states.js';
export type { LifecyclePolicy } from './policies/retention.js';
export { DEFAULT_LIFECYCLE_POLICY, policyOf, trashRetentionMsOf } from './policies/retention.js';
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
  decideSplit,
  decideTrash,
  decideTrashRestore,
  decideUndo,
} from './transitions.js';
