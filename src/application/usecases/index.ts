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
import type { PrefsService } from './prefs.js';
import { createPrefsService } from './prefs.js';
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
export type { PrefsService } from './prefs.js';
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
  readonly prefs: PrefsService;
  readonly tabs: TabsInternalService;
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
  return {
    missions: createMissionService(edge),
    trash: createTrashService(edge),
    undo: createUndoService(edge),
    park: createParkService(edge),
    resume: createResumeService(edge),
    queries: createQueryService(edge),
    portability: createPortabilityService(edge),
    system: createSystemService(edge),
    prefs: createPrefsService(edge),
    tabs: createTabsInternalService(edge),
  };
};
