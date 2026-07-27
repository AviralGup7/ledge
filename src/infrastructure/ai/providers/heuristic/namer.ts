// E8-T01 · providers/heuristic — ladder rung 1, ALWAYS available offline
// (EES §2.12 invariant: "heuristic ladder rung always exists"; Principle 29: AI
// fully OFF ⇒ product coherent). Spec §6.1 failure law made constructive here:
// the rung emits the HONEST LABEL form — "N tabs · domain-words · time" — never
// a guess wearing a lab coat (§5.13). It stamps confidence 0.55: under R7's
// contract constants (MED ≥ 0.60) that is the LOW band ⇒ §6.11 renders the
// neutral heuristic frame — the label is truthful but shallow, and shallow
// truth never borrows the suggestion affordance. Deterministic: same inputs ⇒
// same label (chaos/redelivery idempotence).
import {
  MISSION_SUMMARY_NAME_HINT_MAX_CHARS,
  type AiJobKind,
  type MissionNameInput,
  type MissionSummaryInput,
} from '@/application/ports/ai-jobs.port.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';

export type { MissionNameInput };
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { AiProviderPort } from '../../ladder.js';
import { buildHeuristicMissionSummary } from './summarizer.js';

/** §6.11 low-band anchor under R7's frozen constants (MED ≥ 0.60): the label is
 *  truthful but shallow — neutral-framed, never suggested, never asserted
 *  (E8-T01 F3 recorded the stamp; E8-T02 aligned the tiers to R7). */
export const HEURISTIC_NAMER_CONFIDENCE = 0.55;
export const HEURISTIC_NAMER_MODEL_CLASS = 'heuristic-domain-time-v1';

// Label vocabulary lives in labels.ts (E8-T04 extraction — shared by the naming
// and summary surfaces without an import cycle); re-exported here so the
// E8-T01 public surface stays byte-stable.
import { formatLabelTime, labelWord } from './labels.js';
export { formatLabelTime, labelWord };

const WORD_LIMIT = 2;

/** The §6.1 honest label: "12 tabs · docs & time-tracking · 4:32 pm". */
export const buildHeuristicMissionName = (input: MissionNameInput): string => {
  const words = [...new Set(input.rootDomains.map(labelWord))].slice(0, WORD_LIMIT);
  const domainPart = words.length === 0 ? 'no domains' : words.join(' & ');
  const plural = input.tabCount === 1 ? 'tab' : 'tabs';
  return `${input.tabCount} ${plural} · ${domainPart} · ${formatLabelTime(input.takenAt)}`;
};

/** Rung-1 provider (E8-T04: naming AND the §6.3 shallow-summary form share this
 *  rung/vocabulary). Never rejects by content: the honest label is always
 *  constructible from ANY input (missing domains → "no domains"; the §6.11 low
 *  tier owns semantic shallowness, not this function). */
export const createHeuristicNamer = (): AiProviderPort => ({
  providerId: 'heuristic',
  modelClass: HEURISTIC_NAMER_MODEL_CLASS,
  capabilities: ['mission-name', 'mission-summary'],
  run: async (job: {
    readonly kind: AiJobKind;
    readonly subjectId: string;
    readonly value: unknown;
  }): Promise<Result<MemoryArtifactCandidate, LedgeError>> => {
    const raw = (job.value ?? {}) as Partial<MissionSummaryInput> &
      Readonly<Record<string, unknown>>;
    const input: MissionSummaryInput = {
      tabCount: typeof raw.tabCount === 'number' && raw.tabCount >= 0 ? raw.tabCount : 0,
      rootDomains: Array.isArray(raw.rootDomains)
        ? raw.rootDomains.filter((d): d is string => typeof d === 'string')
        : [],
      takenAt: typeof raw.takenAt === 'number' ? raw.takenAt : 0,
      ...(Array.isArray(raw.tabs) ? { tabs: raw.tabs as MissionSummaryInput['tabs'] } : {}),
      ...(typeof raw.missionNameHint === 'string' && raw.missionNameHint.length > 0
        ? { missionNameHint: raw.missionNameHint.slice(0, MISSION_SUMMARY_NAME_HINT_MAX_CHARS) }
        : {}),
    };
    if (job.kind === 'mission-summary') {
      // E8-T04 fail-down rung (the completion criterion): Spec §6.3's "name +
      // counts remain", as an artifact — structured evidence, zero prose.
      const summary = buildHeuristicMissionSummary(input);
      return ok({
        value: summary.oneLiner,
        confidence: HEURISTIC_NAMER_CONFIDENCE,
        provider: 'heuristic',
        modelClass: HEURISTIC_NAMER_MODEL_CLASS,
        schemaV: 1,
        thread: summary.thread,
      });
    }
    return ok({
      value: buildHeuristicMissionName(input),
      confidence: HEURISTIC_NAMER_CONFIDENCE,
      provider: 'heuristic',
      modelClass: HEURISTIC_NAMER_MODEL_CLASS,
      schemaV: 1,
    });
  },
});
