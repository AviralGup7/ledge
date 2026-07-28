// E3-APP · Application services assembly — the PUBLIC application layer. Surfaces
// (through the dispatch handlers) hold exactly this object shape; every member is a
// use-case facade over ports + the stream appender. Composition lives in roots.
import type { MissionService } from './missions.js';
import { createMissionService } from './missions.js';
import type { TrashService } from './trash.js';
import { createTrashService } from './trash.js';
import type { UndoService } from './undo.js';
import { createUndoService } from './undo.js';
import type { ParkService } from './park.js';
import { createParkService } from './park.js';
import type { ResumeService } from './resume.js';
import { createResumeService } from './resume.js';
import type { QueryService } from './queries.js';
import { createQueryService } from './queries.js';
import type { PortabilityService } from './portability.js';
import { createPortabilityService } from './portability.js';
import type { SystemService } from './system.js';
import { createSystemService } from './system.js';
import type { RecoveryService } from './recovery.js';
import { createRecoveryService } from './recovery.js';
import type { PrefsService } from './prefs.js';
import { createPrefsService } from './prefs.js';
import type { DupesService } from './dupes.js';
import { createDupesService } from './dupes.js';
import type { NudgesService } from './nudges.js';
import { createNudgesService } from './nudges.js';
import type { SwitcherService } from './switcher.js';
import { createSwitcherService } from './switcher.js';
import type { AiJobsService } from './ai-jobs.js';
import { createAiJobsService } from './ai-jobs.js';
import type { TabsInternalService } from './tabs-internal.js';
import { createTabsInternalService } from './tabs-internal.js';
import type { ServiceDeps } from './shared/app-ctx.js';
import { createStreamAppender } from './shared/stream-appender.js';

export type { ServiceDeps, ServiceEdge, UseCtx } from './shared/app-ctx.js';
export { createStreamAppender } from './shared/stream-appender.js';
export type { MissionService } from './missions.js';
export type { TrashService } from './trash.js';
export type { UndoService } from './undo.js';
export type { ParkService } from './park.js';
export type { ResumeService } from './resume.js';
export type { QueryService } from './queries.js';
export type { PortabilityService } from './portability.js';
export type { SystemService } from './system.js';
export type { RecoveryService } from './recovery.js';
export type { PrefsService } from './prefs.js';
export type { DupesService } from './dupes.js';
export { DUPE_IGNORE_PREFIX } from './dupes.js';
export type { NudgesService, SprawlNudgeOffer } from './nudges.js';
export type { SwitchOutcome, SwitcherItem, SwitcherService } from './switcher.js';
export {
  META_NUDGE_DAY_PREFIX,
  META_NUDGE_DISMISS_PREFIX,
  NUDGE_TYPE_SPRAWL,
  SETTING_SUGGESTIONS_ALL,
  SETTING_SUGGESTIONS_NUDGES,
} from './nudges.js';
export type { TabsInternalService } from './tabs-internal.js';

/** The public application surface (one service per use-case family). */
export interface AppServices {
  readonly missions: MissionService;
  readonly trash: TrashService;
  readonly undo: UndoService;
  readonly park: ParkService;
  readonly resume: ResumeService;
  readonly queries: QueryService;
  readonly portability: PortabilityService;
  readonly system: SystemService;
  readonly recovery: RecoveryService;
  readonly prefs: PrefsService;
  /** E8-T07 dupe markers→actions (opt-in law; parks older copies only). */
  readonly dupes: DupesService;
  /** E8-T08 the one-a-day sprawl whisper (§6.10/R15; errs to never). */
  readonly nudges: NudgesService;
  /** E8-T09 the atomic park+switch (C28; park-fail aborts the whole intent). */
  readonly switcher: SwitcherService;
  readonly tabs: TabsInternalService;
  /** E8-T01 AI job pipeline service — ABSENT when deps.ai is unwired (hosts
   *  without the AI graph; the ai-lanes probe reports honest grey there). */
  readonly aiJobs?: AiJobsService | undefined;
}

/** One assembly, one appender (the per-device stamping law is per-GRAPH, not per-service). */
export const createServices = (deps: ServiceDeps): AppServices => {
  const appender = createStreamAppender({
    journal: deps.journal,
    projections: deps.projections,
    deviceId: deps.deviceId,
    ids: deps.ids,
    now: deps.now,
  });
  const edge = { deps, appender };
  const park = createParkService(edge);
  const resume = createResumeService(edge);
  return {
    missions: createMissionService(edge),
    trash: createTrashService(edge),
    undo: createUndoService(edge),
    park,
    resume,
    queries: createQueryService(edge),
    portability: createPortabilityService(edge),
    system: createSystemService(edge),
    recovery: createRecoveryService(edge),
    prefs: createPrefsService(edge),
    // E8-T07: the strip's one-tap action rides the flagship park vocabulary
    // per tab (composition seam — the use-case never reaches adapters itself).
    dupes: createDupesService(edge, { parkTab: (input, ctx) => park.parkTab(input, ctx) }),
    // E8-T08: same park vocabulary for the whisper's gesture; the R15 bucket
    // clock rides the HOST offset (getTimezoneOffset is minutes-behind-UTC,
    // so the local-midnight floor wants its negation).
    nudges: createNudgesService(
      edge,
      { parkTab: (input, ctx) => park.parkTab(input, ctx) },
      { offsetMinutes: () => -new Date().getTimezoneOffset() },
    ),
    // E8-T09: the C28 chain rides the flagship park/resume phases as seams
    // (single intent, checkpointed cids — composition, never adaptation).
    switcher: createSwitcherService(edge, {
      parkWindow: (input, ctx) => park.parkWindow(input, ctx),
      resumeMission: (input, ctx) => resume.resumeMission(input, ctx),
    }),
    tabs: createTabsInternalService(edge),
    ...(deps.ai !== undefined ? { aiJobs: createAiJobsService(edge, deps.ai) } : {}),
  };
};
