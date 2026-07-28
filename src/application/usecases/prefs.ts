// E3-APP · Memory/prefs service — the mission's Tag/Favorite/Pin use cases per the
// locked spec mappings (adr-noted): Tag ≡ Topics correction (user-tags rejected by
// Spec §3.6; AI Topics are chip-editable via W16) — truth through memory_artifacts
// events. Favorite/Pin ≡ settings carriers (ADR-035 LWW per-entity keys;
// `favorite.mission.<id>`, `pinnedMission.<id>`) — browser-level tab pinning is the
// TabsPort adapter tier (adr-noted remaining work).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';

const PREFS_OP = 'command:prefs';

export interface PrefsService {
  /** W16 one-gesture teaching: user-corrected topic overwrites (invalidate + write). */
  correctTopic(
    input: {
      readonly subjectId: string;
      readonly value: string;
      readonly priorArtifactId?: string | undefined;
    },
    ctx: UseCtx,
  ): Promise<Result<{ readonly artifactId: string }, LedgeError>>;
  /** Settings carrier: favorite marker for one entity (mission or tab id). */
  setFavorite(
    input: { readonly entityKind: 'mission' | 'tab'; readonly id: string; readonly favor: boolean },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
  /** Settings carrier: pin marker for one mission (browser tab-pin is adapter-tier). */
  setPinned(
    input: { readonly id: string; readonly pinned: boolean },
    ctx: UseCtx,
  ): Promise<Result<Record<string, never>, LedgeError>>;
  /**
   * E8-T05 (Spec §6.9 · W5 "Don't show again"): dismiss a mission's resumption
   * brief FOREVER. Preference, not deletion (ADR nota e8-resumption-briefs J4):
   * the artifact stands for other surfaces — the dismissal event is what the
   * brief gate (domain/memory/briefsGate) reads to answer 'dismissed'.
   * Re-dismiss of the same mission converges (projection keys on missionId);
   * a redelivered command cid dedupes at the appender like every command.
   */
  dismissMissionBrief(
    input: { readonly missionId: string; readonly briefArtifactId?: string | undefined },
    ctx: UseCtx,
  ): Promise<Result<{ readonly briefDismissalId: string }, LedgeError>>;
}

export const createPrefsService = (edge: ServiceEdge): PrefsService => {
  const { deps, appender } = edge;

  const settingWrite = async (
    family: string,
    cid: string,
    key: string,
    value: boolean,
  ): Promise<Result<Record<string, never>, LedgeError>> => {
    const written = await deps.engine.txn(['settings'], 'readwrite', async (tx) => {
      await tx.table('settings').put({ key, value, schemaV: 1, updatedAt: deps.now() });
    });
    if (!written.ok) return err(written.error);
    const committed = await appender.commit({
      plans: [{ type: 'SettingsChanged', payload: { key, value, schemaV: 1 } }],
      key: opKey(edge, family, cid),
    });
    if (!committed.ok) return err(committed.error);
    return ok({});
  };

  return {
    correctTopic: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const trimmed = input.value.replace(/\s+/g, ' ').trim();
      if (trimmed.length === 0) {
        return err(ledgeError('E_DOMAIN_LEGALITY', { operation: PREFS_OP, reason: 'topic-empty' }));
      }
      const artifactId = deps.ids.nextId();
      const plans = [
        ...(input.priorArtifactId !== undefined && input.priorArtifactId.length > 0
          ? [
              {
                type: 'MemoryArtifactInvalidated',
                payload: { artifactId: input.priorArtifactId, cause: 'user-correction' },
              },
            ]
          : []),
        {
          type: 'MemoryArtifactWritten',
          payload: {
            artifactId,
            subjectId: input.subjectId,
            kind: 'topic',
            value: trimmed,
            // User corrections carry CERTAINTY semantics (confidence 1, provider
            // 'user') — the W16 law "never argue with the user" as data.
            confidence: 1,
            provider: 'user',
            modelClass: 'user-correction',
            schemaV: 1,
            derivedFromSeqRange: { from: 0, to: 0 },
          },
        },
      ];
      const committed = await appender.commit({
        plans,
        key: opKey(edge, 'CorrectTopic', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({ artifactId });
    },

    setFavorite: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const key = `favorite.${input.entityKind}.${input.id}`;
      return settingWrite('SetFavorite', ctx.cid, key, input.favor);
    },

    setPinned: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      const key = `pinnedMission.${input.id}`;
      return settingWrite('SetPinned', ctx.cid, key, input.pinned);
    },

    dismissMissionBrief: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (input.missionId.trim().length === 0) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: PREFS_OP, reason: 'mission-id-empty' }),
        );
      }
      const briefDismissalId = deps.ids.nextId();
      const committed = await appender.commit({
        plans: [
          {
            type: 'BriefDismissed',
            payload: {
              briefDismissalId,
              missionId: input.missionId,
              dismissedAt: deps.now(),
              ...(input.briefArtifactId !== undefined && input.briefArtifactId.length > 0
                ? { briefArtifactId: input.briefArtifactId }
                : {}),
            },
          },
        ],
        key: opKey(edge, 'DismissBrief', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      return ok({ briefDismissalId });
    },
  };
};
