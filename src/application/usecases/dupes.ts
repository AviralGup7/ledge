// E8-T07 · Dupe actions use-case — markers → ONE-TAP actions under the opt-in
// law (Spec: the lane "marks, does not close"; roadmap completion: "No silent
// closing (spec) — action tests"). Laws this service keeps:
//  * PARK IS THE ONLY CLOSING VOCABULARY: a dupe action parks the older
//    copies (reversible, Ledge's own grammar) — nothing here, and nothing
//    callable from here, ever closes a browser tab silently.
//  * ACT-ON-NOW TRUTH: every action re-derives the group from a fresh read;
//    a group that dissolved since the strip rendered is a calm legality
//    answer, never a stale write.
//  * CONVERGENT IDEMPOTENCE: a redelivered tap parks nothing twice — already-
//    parked rows stop being live, so each per-tab park dedupes (ledger cid)
//    or converges (E_NOT_FOUND_TAB tolerated as already-done).
//  * DISMISS IS A SETTING, NOT AN EVENT-CLASS: per-group "ignore" rides the
//    ADR-035 LWW settings carrier (`dupeIgnore.<canonHash>`), exactly like
//    favorites/pins — memory events are for memory truth, and a strip
//    preference is not one.
import { findDupeGroups, type DupeGroup } from '@/domain/lifecycle/index.js';
import type { DupeGroupInput } from '@/domain/lifecycle/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { StoredRecord } from '@/application/ports/storage-engine.port.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import { readLiveTabs, readSettingsRows } from './shared/rows.js';

const DUPES_OP = 'command:dupes';
/** Settings carrier prefix (ADR-035 LWW per-key; the hash IS the group's
 *  identity — a canon-rules bump honestly re-groups under new keys). */
export const DUPE_IGNORE_PREFIX = 'dupeIgnore.';

/** The park seam (composition injects the flagship service; the use-case
 *  never reaches infrastructure by itself — ADR-025/root law). */
export interface DupesParkSeam {
  readonly parkTab: (
    input: { readonly browserTabId: number },
    ctx: UseCtx,
  ) => Promise<Result<{ readonly kept: string }, LedgeError>>;
}

export interface DupesService {
  /** Open-duplicate groups for the strip (settings-filtered, strip-capped). */
  listDupeGroups(ctx: UseCtx): Promise<Result<readonly DupeGroup[], LedgeError>>;
  /** ONE tap: park every older copy of the group, keeping the named tab. */
  parkDupeGroup(
    input: { readonly canonHash: string; readonly keepBrowserTabId: number },
    ctx: UseCtx,
  ): Promise<Result<{ readonly parkedCount: number }, LedgeError>>;
  /** Per-group dismiss memory (the strip never re-shows an ignored hash). */
  setDupeGroupIgnored(
    input: { readonly canonHash: string; readonly ignored: boolean },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const inputTabOf = (row: StoredRecord): DupeGroupInput | null => {
  const ledgeTabId = str(row['ledgeTabId']);
  const browserTabId = num(row['browserTabId']);
  if (ledgeTabId.length === 0 || browserTabId === undefined) return null;
  return {
    ledgeTabId,
    browserTabId,
    title: str(row['title']),
    url: str(row['url']),
    domain: str(row['domain']),
    lastActiveAt: num(row['lastActiveAt']) ?? num(row['firstSeenAt']) ?? 0,
  };
};

const ignoredHashes = (settings: readonly StoredRecord[]): ReadonlySet<string> => {
  const ignored = new Set<string>();
  for (const row of settings) {
    const key = str(row['key']);
    if (key.startsWith(DUPE_IGNORE_PREFIX) && row['value'] === true) {
      ignored.add(key.slice(DUPE_IGNORE_PREFIX.length));
    }
  }
  return ignored;
};

export const createDupesService = (edge: ServiceEdge, seams: DupesParkSeam): DupesService => {
  const { deps, appender } = edge;

  const currentGroups = async (): Promise<Result<readonly DupeGroup[], LedgeError>> => {
    const live = await readLiveTabs(deps.engine);
    if (!live.ok) return err(live.error);
    const settings = await readSettingsRows(deps.engine);
    if (!settings.ok) return err(settings.error);
    const inputs = live.value.map(inputTabOf).filter((t): t is DupeGroupInput => t !== null);
    return ok(findDupeGroups(inputs, ignoredHashes(settings.value)));
  };

  return {
    listDupeGroups: async (ctx) => {
      ctx.token.throwIfCancelled();
      return currentGroups();
    },

    parkDupeGroup: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const groups = await currentGroups();
      if (!groups.ok) return err(groups.error);
      const group = groups.value.find((g) => g.canonHash === input.canonHash);
      // Act-on-now law: the strip's snapshot is a hint; the group at action
      // time is the truth. A dissolved group is a calm terminal, not a write.
      if (group === undefined) {
        return err(ledgeError('E_DOMAIN_LEGALITY', { operation: DUPES_OP, reason: 'group-gone' }));
      }
      if (group.keep.browserTabId !== input.keepBrowserTabId) {
        // The keep pick CHANGED since the strip rendered (someone used the
        // candidates) — refuse rather than park around a stale choice.
        return err(ledgeError('E_DOMAIN_LEGALITY', { operation: DUPES_OP, reason: 'keep-moved' }));
      }
      let parkedCount = 0;
      for (const [index, tab] of group.parkCandidates.entries()) {
        ctx.token.throwIfCancelled(); // last checkpoint before each paid close
        const parked = await seams.parkTab(
          { browserTabId: tab.browserTabId },
          { ...ctx, cid: `${ctx.cid}:${index}` },
        );
        if (parked.ok) {
          parkedCount += 1;
          continue;
        }
        // Convergent idempotence: the row already left 'live' (a redelivery
        // or a manual park beat us) — the goal state stands, count it not.
        if (parked.error.code === 'E_NOT_FOUND_TAB') continue;
        return err(parked.error); // honest partial state; the strip re-pulls
      }
      return ok({ parkedCount });
    },

    setDupeGroupIgnored: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.canonHash.trim().length === 0) {
        return err(ledgeError('E_DOMAIN_LEGALITY', { operation: DUPES_OP, reason: 'hash-empty' }));
      }
      const key = `${DUPE_IGNORE_PREFIX}${input.canonHash}`;
      const written = await deps.engine.txn(['settings'], 'readwrite', async (tx) => {
        await tx
          .table('settings')
          .put({ key, value: input.ignored, schemaV: 1, updatedAt: deps.now() });
      });
      if (!written.ok) return err(written.error);
      const committed = await appender.commit({
        plans: [{ type: 'SettingsChanged', payload: { key, value: input.ignored, schemaV: 1 } }],
        key: opKey(edge, 'DupeIgnore', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({});
    },
  };
};
