// Public surface of infrastructure/projections (EES §2.10, E2-T03).
import type { ProjectorDef } from '@/application/ports/projection-engine.port.js';
import { missionsProjector } from './core/projectors/missions.projector.js';
import { recentlyClosedProjector } from './core/projectors/recently-closed.projector.js';
import type { ProjectionEngineDeps } from './core/engine.js';
import { createProjectionEngine } from './core/engine.js';

export { createProjectionEngine } from './core/engine.js';
export type { ProjectionEngineDeps } from './core/engine.js';
export { missionsProjector } from './core/projectors/missions.projector.js';
export { recentlyClosedProjector } from './core/projectors/recently-closed.projector.js';

/**
 * The v1 projector set (registry grows with use-cases; projectorV bumps trigger
 * rebuild-on-change per §2.10's versioning law). This is the shape surface roots
 * compose; tests inject narrower sets freely (manual DI, ADR-025).
 */
export const V1_PROJECTORS: readonly ProjectorDef[] = [missionsProjector, recentlyClosedProjector];

/** Convenience factory on the full v1 set. */
export const createV1ProjectionEngine = (
  deps: Omit<ProjectionEngineDeps, 'projectors'>,
): ReturnType<typeof createProjectionEngine> =>
  createProjectionEngine({ ...deps, projectors: V1_PROJECTORS });
