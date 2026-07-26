// Public surface of infrastructure/projections (EES §2.10, E2-T03).
import type { ProjectorDef } from '@/application/ports/projection-engine.port.js';
import { missionsProjector } from './core/projectors/missions.projector.js';
import { recentlyClosedProjector } from './core/projectors/recently-closed.projector.js';
import { tabsStoreProjector } from './core/projectors/tabs.projector.js';
import { sessionsProjector } from '../snapshots/sessions.projector.js';
import { searchIndexProjector } from '../search/index.projector.js';
import type { ProjectionEngineDeps } from './core/engine.js';
import { createProjectionEngine } from './core/engine.js';

export { createProjectionEngine } from './core/engine.js';
export { tabsStoreProjector } from './core/projectors/tabs.projector.js';
export type { ProjectionEngineDeps } from './core/engine.js';
export { missionsProjector } from './core/projectors/missions.projector.js';
export { recentlyClosedProjector } from './core/projectors/recently-closed.projector.js';

/**
 * The v1 projector set (registry grows with use-cases; projectorV bumps trigger
 * rebuild-on-change per §2.10's versioning law). This is the shape surface roots
 * compose; tests inject narrower sets freely (manual DI, ADR-025).
 * SessionsView (E2-T08) lives in infrastructure/snapshots (its family's home)
 * and registers here — the engine owns execution, the family owns the row law.
 * searchIndex (E5-T01) is engine-internal: its frames never ride the wire
 * (the outbox gates the ADR-010 window to the four surface views).
 */
export const V1_PROJECTORS: readonly ProjectorDef[] = [
  missionsProjector,
  recentlyClosedProjector,
  sessionsProjector,
  tabsStoreProjector,
  searchIndexProjector,
];

/** Convenience factory on the full v1 set. */
export const createV1ProjectionEngine = (
  deps: Omit<ProjectionEngineDeps, 'projectors'>,
): ReturnType<typeof createProjectionEngine> =>
  createProjectionEngine({ ...deps, projectors: V1_PROJECTORS });
