// E2-T03 · projections internals: meta watermark rows + drive constants.
import type { ViewName, Watermark } from '@/application/ports/projection-engine.port.js';

/** meta row name for per-(view, device) watermarks (EES §2.10 versioning law). */
export const META_WATERMARKS_KEY = 'projection.watermarks';

/** Watermark table value: key `${view}:${deviceId}` → row (projectorV + dirty ride §2.10). */
export type WatermarkRow = Watermark & {
  readonly view: ViewName;
  readonly projectorV: number;
  readonly dirty: boolean;
};

export type WatermarkTable = Record<string, WatermarkRow>;

export const watermarkKeyFor = (view: ViewName, deviceId: string): string => `${view}:${deviceId}`;

/** Events per apply-chunk txn: a kill mid-drive resumes from the last committed
 *  watermark — the recovery-after-interrupted-replay law. */
export const APPLY_CHUNK = 20;

/** §3.5 ViewDelta hard cap per frame (engine splits bigger bursts). */
export const FRAME_OPS_CAP = 500;
