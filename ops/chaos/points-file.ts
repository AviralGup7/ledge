// E2-T09 · ops/chaos/points.txt reader — the enumerated kill-point list is the
// single source of truth (PR-template law: EVERY mutation path's crash
// boundaries land there; never remove points, deprecate by comment only).
// This reader is the ONE normalization of the file the whole harness shares:
// trim, drop blanks, drop comment lines. Parsers in the owner suites
// (reconciler/marker chaos) apply the same normalization; the constitution
// test in ops/tests/chaos proves the file, the manifest, and both owner
// partitions describe the same point set.
import { readFileSync } from 'node:fs';

const POINTS_FILE_URL = new URL('./points.txt', import.meta.url);

/** Normative kill-point lines, in file order (comments + blanks stripped). */
export const readKillPoints = (): readonly string[] =>
  readFileSync(POINTS_FILE_URL, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

/** Raw normative text (post-normalization) — the digest input the G1 evidence
 *  report pins, so a point-list edit always re-ids the evidence. */
export const readKillPointsNormative = (): string => readKillPoints().join('\n');
