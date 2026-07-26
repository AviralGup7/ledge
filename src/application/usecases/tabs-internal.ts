// E3-APP · Internal tabs service (mission use cases Open Tabs / Close Tabs — internal
// Tier-2 per the frozen v1 wire registry: no new wire names). Pure browser actions
// through the §6 ports; durable truth arrives via chrome observation → ingest (the
// observation pipeline is the one truth path — services never fake-ingest).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';

export interface TabsInternalService {
  /** Open urls (into a window when given). Returns the created browserTabIds. */
  openTabs(
    input: {
      readonly urls: readonly string[];
      readonly windowId?: number | undefined;
    },
    ctx: UseCtx,
  ): Promise<Result<{ readonly created: readonly number[] }, LedgeError>>;
  /** Bare closes (cleanup flows). Keeping-with-closing is the PARK family. */
  closeTabs(
    input: { readonly browserTabIds: readonly number[] },
    ctx: UseCtx,
  ): Promise<Result<{ readonly closed: number }, LedgeError>>;
}

export const createTabsInternalService = (edge: ServiceEdge): TabsInternalService => {
  const { deps } = edge;
  return {
    openTabs: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.urls.length === 0)
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: 'internal:OpenTabs', reason: 'empty' }),
        );
      const created: number[] = [];
      for (const url of input.urls) {
        ctx.token.throwIfCancelled();
        const r = await deps.tabs.create({
          url,
          ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
        });
        if (!r.ok) return err(r.error);
        created.push(r.value);
        ctx.progress({
          stage: 1 + created.length,
          current: created.length,
          total: input.urls.length,
        });
      }
      return ok({ created });
    },

    closeTabs: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const removed = await deps.tabs.remove(input.browserTabIds);
      if (!removed.ok) return err(removed.error);
      return ok({ closed: removed.value.length });
    },
  };
};
