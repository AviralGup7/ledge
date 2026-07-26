// E3-APP · meta.undoStack law (§5 meta row: cap per policy — default 20 — push/pop
// transactional with the truth-write they invert). The stack is the material of the
// universal-undo gesture (Spec §5.12): every atom-replayable decision pushes; Undo
// pops the top and replays it THROUGH THE HUB as that atom's own §4 events (no novel
// undo events — the journal stays a closed replayable world).
// Push rides the committing append's hinge (one fate: the inverse atom exists iff the
// destructive fact exists). Pop is optimistic-currency-checked inside the replay's
// hinge: a concurrent pop that moved the top aborts the whole replay honestly.
import type { StoreName, TxScope } from '@/application/ports/storage-engine.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import { ledgeError, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

/** §5 meta row shape (key/value). */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

export const META_UNDO_STACK_KEY = 'undoStack';

/** One stack entry: the inverse atom + its descriptor (copy-catalog key, §3.2). */
export interface UndoEntry {
  readonly atomId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly label: string;
  readonly pushedAt: number;
}

export const UNDO_STACK_STORES: readonly StoreName[] = ['meta'];

const readStackFrom = async (tx: TxScope): Promise<readonly UndoEntry[]> => {
  const row = await tx.table<MetaRow>('meta').get(META_UNDO_STACK_KEY);
  return Array.isArray(row?.value) ? (row.value as readonly UndoEntry[]) : [];
};

/** Read-side depth/top probe (decision input for the undo decider — stack non-empty). */
export const readUndoStack = async (
  engine: StorageEnginePort,
): Promise<Result<readonly UndoEntry[], LedgeError>> =>
  engine.txn(UNDO_STACK_STORES, 'readonly', async (tx) => readStackFrom(tx));

/**
 * Hinge writer factory: push an entry, capped (oldest drop). Runs inside the
 * committing append's txn — never its own write path.
 */
export const pushUndoHinge =
  (entry: UndoEntry, cap: number): ((tx: TxScope) => Promise<void>) =>
  async (tx: TxScope): Promise<void> => {
    const stack = await readStackFrom(tx);
    const next = [...stack, entry];
    const capped = next.length > cap ? next.slice(next.length - cap) : next;
    await tx.table<MetaRow>('meta').put({ key: META_UNDO_STACK_KEY, value: capped });
  };

/**
 * Hinge writer factory: pop ONLY if the top is still `expectedAtomId` (optimistic
 * currency inside the replay's txn — a moved top aborts everything: two undos cannot
 * both consume the same gesture).
 */
export const popUndoHinge =
  (expectedAtomId: string): ((tx: TxScope) => Promise<void>) =>
  async (tx: TxScope): Promise<void> => {
    const stack = await readStackFrom(tx);
    const top = stack[stack.length - 1];
    if (top === undefined || top.atomId !== expectedAtomId) {
      throw ledgeError('E_CAPABILITY', { operation: 'undo', fault: 'stack-moved' });
    }
    await tx.table<MetaRow>('meta').put({ key: META_UNDO_STACK_KEY, value: stack.slice(0, -1) });
  };
