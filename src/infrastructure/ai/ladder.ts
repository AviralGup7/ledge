// E8-T01 · infrastructure/ai — the provider ladder (ADR-018): a capability-typed
// ordered fallback chain assembled from a VERSIONED capability matrix, with a
// per-provider circuit breaker (EES §2.12 failure law: provider error/timeout ⇒
// circuit break + next rung). The heuristic rung is CONSTITUTIONALLY LAST and
// ALWAYS eligible (EES §2.12 "heuristic ladder rung always exists" — the chain
// can never resolve to empty while a heuristic provider covers the kind).
import type { AiJobKind } from '@/application/ports/ai-jobs.port.js';
import type { BreakerState, ProviderBreakerReport } from '@/application/ports/ai-jobs.port.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

export type { BreakerState, ProviderBreakerReport };

/** One rung's execution face. Providers are pure compute over the job input —
 *  capability detection/upgrades ride the matrix, not this seam. */
export interface AiProviderPort {
  readonly providerId: string;
  readonly modelClass: string;
  readonly capabilities: readonly AiJobKind[];
  readonly run: (input: {
    readonly kind: AiJobKind;
    readonly subjectId: string;
    readonly value: unknown;
  }) => Promise<Result<MemoryArtifactCandidate, LedgeError>>;
}

/** Breaker policy (EES §10 doctrine: breaker on provider latency/failure past
 *  threshold; cooldown before a half-open probe). Heuristic rung is infallible
 *  by construction, so thresholds here serve the ML/builtin/cloud rungs landing
 *  in E8-T03/T06 — the machinery is real from day one, its evidence rows ride
 *  the ai-lanes probe. */
export const BREAKER_OPEN_AT_FAILURES = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

/**
 * Provider capability matrix v1 (EES §2.12 "provider capability matrix
 * versioned"). Rung order per kind is ADR-018's chain: Heuristic → OnDeviceML →
 * BuiltIn → CloudDepth (latter rungs join by capability detection in E8-T03/T06;
 * absent entries are simply not registered — degrade is structural).
 */
export const PROVIDER_MATRIX_V = 1;

export interface AiLadderDeps {
  readonly providers: readonly AiProviderPort[];
}

export interface AiLadder {
  /** Ordered eligible rungs for one attempt: matrix order, breaker-skipped. The
   *  force flag collapses to the heuristic rung (§9 row 6 lane-fallback law —
   *  heuristic is identified by model class prefix, never by position games). */
  resolve: (input: {
    readonly kind: AiJobKind;
    readonly now: number;
    readonly forceHeuristic: boolean;
  }) => readonly AiProviderPort[];
  noteSuccess(providerId: string): void;
  noteFailure(input: { readonly providerId: string; readonly now: number }): void;
  /** §12 ai-lanes probe evidence rows. */
  breakerReports(): readonly ProviderBreakerReport[];
}

const HEURISTIC_MODEL_PREFIX = 'heuristic-';

interface BreakerCell {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
}

const closedCell = (): BreakerCell => ({ state: 'closed', consecutiveFailures: 0, openedAt: null });

export function createAiLadder(deps: AiLadderDeps): AiLadder {
  const breakers = new Map<string, BreakerCell>();
  for (const provider of deps.providers) breakers.set(provider.providerId, closedCell());

  const cellFor = (providerId: string): BreakerCell => {
    const cell = breakers.get(providerId);
    if (cell !== undefined) return cell;
    const fresh = closedCell();
    breakers.set(providerId, fresh);
    return fresh;
  };

  const eligibleByBreaker = (provider: AiProviderPort, now: number): boolean => {
    const cell = cellFor(provider.providerId);
    // Heuristic rung never breaks (it owns no remote/model dependency).
    if (provider.modelClass.startsWith(HEURISTIC_MODEL_PREFIX)) return true;
    if (cell.state === 'open') {
      if (cell.openedAt !== null && now - cell.openedAt >= BREAKER_COOLDOWN_MS) {
        // Half-open probe: one candidate attempt may pass; its outcome re-opens
        // or closes the cell via note{Success,Failure}.
        cell.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  };

  return {
    resolve: ({ kind, now, forceHeuristic }) => {
      const capable = deps.providers.filter((p) => p.capabilities.includes(kind));
      const heuristic = capable.filter((p) => p.modelClass.startsWith(HEURISTIC_MODEL_PREFIX));
      const elevated = capable.filter((p) => !p.modelClass.startsWith(HEURISTIC_MODEL_PREFIX));
      if (forceHeuristic) return heuristic;
      // Matrix law: elevated rungs first (heuristic LAST as the constitutional
      // fallback). ADR-018's chain order is the registration order for equal rungs.
      return [...elevated.filter((p) => eligibleByBreaker(p, now)), ...heuristic];
    },

    noteSuccess: (providerId) => {
      const cell = cellFor(providerId);
      cell.state = 'closed';
      cell.consecutiveFailures = 0;
      cell.openedAt = null;
    },

    noteFailure: ({ providerId, now }) => {
      const cell = cellFor(providerId);
      cell.consecutiveFailures += 1;
      const provider = deps.providers.find((p) => p.providerId === providerId);
      // Heuristic never opens (see eligibleByBreaker's law); failures still count
      // as evidence, never as a trip.
      if (provider?.modelClass.startsWith(HEURISTIC_MODEL_PREFIX) === true) return;
      if (cell.state === 'half-open' || cell.consecutiveFailures >= BREAKER_OPEN_AT_FAILURES) {
        cell.state = 'open';
        cell.openedAt = now;
      }
    },

    breakerReports: () =>
      deps.providers.map((p) => {
        const cell = cellFor(p.providerId);
        return {
          providerId: p.providerId,
          state: cell.state,
          consecutiveFailures: cell.consecutiveFailures,
          openedAt: cell.openedAt,
        };
      }),
  };
}
