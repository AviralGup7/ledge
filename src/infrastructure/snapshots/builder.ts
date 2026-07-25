// E2-T08 · snapshot builder (pure) — produces the SnapshotTaken payload whose
// chunking the sessions projector + probe mirror exactly. Three laws live here
// and nowhere else:
//
//   DEDUPE (R5 accounting): duplicate refs are dropped order-stably at first
//   occurrence — one tab is secured once, parts never double-secure.
//   CHUNK (R5): partCount = ceil(dedupedRefs / 500); canonical chunk layout is
//   derived by chunkRefs below, and the projector/probe call the same function
//   — there is ONE definition of "part" in the system.
//   REFERENTIAL (R4-partition): style tabOrder may only reference snapshot refs;
//   orphans are pruned with disclosure (never silently — diagnostics + count).
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { isId } from '@/shared-kernel/identity/index.js';
import {
  SNAPSHOT_CHUNK_SIZE,
  SNAPSHOT_TRIGGERS,
  type GroupStyle,
  type SnapshotBuild,
  type SnapshotInput,
  type SnapshotTrigger,
} from './types.js';

/** The canonical chunk layout: [refs[0:500), refs[500:1000), …]. */
export const chunkRefs = (refs: readonly string[]): readonly (readonly string[])[] => {
  const chunks: string[][] = [];
  for (let i = 0; i < refs.length; i += SNAPSHOT_CHUNK_SIZE) {
    chunks.push(refs.slice(i, i + SNAPSHOT_CHUNK_SIZE));
  }
  return chunks;
};

export const partCountOf = (refCount: number): number => Math.ceil(refCount / SNAPSHOT_CHUNK_SIZE);

/** Order-stable first-win dedupe (reports how many fell). */
export const dedupeRefs = (refs: readonly string[]): { refs: string[]; dropped: number } => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return { refs: out, dropped: refs.length - out.length };
};

/**
 * Style ⊆ parts after orphan pruning. A style whose tabOrder empties entirely
 * is KEPT (an empty-but-present group is still a style fact for restore), and
 * disclosed via emptiedStyles.
 */
const pruneStyles = (
  styles: readonly GroupStyle[],
  refSet: ReadonlySet<string>,
): { styles: GroupStyle[]; prunedRefs: number; emptied: number } => {
  let prunedRefs = 0;
  let emptied = 0;
  const out: GroupStyle[] = [];
  for (const style of styles) {
    const kept = style.tabOrder.filter((id) => refSet.has(id));
    prunedRefs += style.tabOrder.length - kept.length;
    if (kept.length === 0 && style.tabOrder.length > 0) emptied += 1;
    out.push({ ...style, tabOrder: kept });
  }
  return { styles: out, prunedRefs, emptied };
};

const isTrigger = (v: unknown): v is SnapshotTrigger =>
  typeof v === 'string' && (SNAPSHOT_TRIGGERS as readonly string[]).includes(v);

const isValidStyle = (s: GroupStyle): boolean =>
  Number.isInteger(s.groupId) &&
  s.groupId >= 0 &&
  typeof s.name === 'string' &&
  typeof s.color === 'string' &&
  typeof s.collapsed === 'boolean' &&
  Array.isArray(s.tabOrder) &&
  s.tabOrder.every((id) => typeof id === 'string');

/**
 * Build the SnapshotTaken payload. Pure + total on well-typed input; type- and
 * shape-law violations are E_OUTPUT_MALFORMED errors, never partial payloads.
 */
export const buildSnapshotPayload = (input: SnapshotInput): Result<SnapshotBuild, LedgeError> => {
  if (!isId(input.snapshotId) || !isId(input.missionId)) {
    return err(
      ledgeError('E_OUTPUT_MALFORMED', { what: 'snapshot-ids', field: 'snapshotId/missionId' }),
    );
  }
  if (!Number.isFinite(input.takenAt)) {
    return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'snapshot-takenAt', field: 'takenAt' }));
  }
  if (!isTrigger(input.trigger)) {
    return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'snapshot-trigger', field: 'trigger' }));
  }
  for (const ref of input.tabRecordIds) {
    if (!isId(ref)) {
      return err(ledgeError('E_OUTPUT_MALFORMED', { what: 'snapshot-ref', field: 'tabRecordIds' }));
    }
  }
  for (const style of input.groupStyles) {
    if (!isValidStyle(style)) {
      return err(
        ledgeError('E_OUTPUT_MALFORMED', { what: 'snapshot-style', field: 'groupStyles' }),
      );
    }
  }

  const { refs, dropped } = dedupeRefs(input.tabRecordIds as readonly string[]);
  const refSet = new Set(refs);
  const { styles, prunedRefs, emptied } = pruneStyles(input.groupStyles, refSet);
  const partCount = partCountOf(refs.length);

  return ok({
    payload: {
      snapshotId: input.snapshotId as string,
      missionId: input.missionId as string,
      partCount,
      tabRecordRefs: refs,
      groupStyles: styles,
      takenAt: input.takenAt,
      trigger: input.trigger,
    },
    diagnostics: {
      partCount,
      dedupedRefs: dropped,
      prunedStyleRefs: prunedRefs,
      emptiedStyles: emptied,
    },
  });
};

/**
 * The style partition law (projector + probe share it): a style belongs to a
 * part iff its tabOrder intersects the part's refs; the record rides whole
 * (order truth intact), so one part restores alone.
 */
export const stylesForPart = (
  styles: readonly GroupStyle[],
  partRefs: readonly string[],
): GroupStyle[] => {
  const partSet = new Set(partRefs);
  return styles
    .filter((s) => s.tabOrder.some((id) => partSet.has(id)))
    .map((s) => ({ ...s, tabOrder: [...s.tabOrder] }));
};
