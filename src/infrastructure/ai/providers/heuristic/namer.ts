// E8-T01 · providers/heuristic — ladder rung 1, ALWAYS available offline
// (EES §2.12 invariant: "heuristic ladder rung always exists"; Principle 29: AI
// fully OFF ⇒ product coherent). Spec §6.1 failure law made constructive here:
// the rung emits the HONEST LABEL form — "N tabs · domain-words · time" — never
// a guess wearing a lab coat (§5.13). It stamps confidence 0.55: under R7's
// contract constants (MED ≥ 0.60) that is the LOW band ⇒ §6.11 renders the
// neutral heuristic frame — the label is truthful but shallow, and shallow
// truth never borrows the suggestion affordance. Deterministic: same inputs ⇒
// same label (chaos/redelivery idempotence).
import type { AiJobKind, MissionNameInput } from '@/application/ports/ai-jobs.port.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';

export type { MissionNameInput };
import { ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { AiProviderPort } from '../../ladder.js';

/** §6.11 low-band anchor under R7's frozen constants (MED ≥ 0.60): the label is
 *  truthful but shallow — neutral-framed, never suggested, never asserted
 *  (E8-T01 F3 recorded the stamp; E8-T02 aligned the tiers to R7). */
export const HEURISTIC_NAMER_CONFIDENCE = 0.55;
export const HEURISTIC_NAMER_MODEL_CLASS = 'heuristic-domain-time-v1';

const HOURS_PER_HALF_DAY = 12;
const LEADING = 10;

/** "4:32 pm" — lowercase meridiem, zero-padded minutes (spec example verbatim). */
export const formatLabelTime = (takenAt: number): string => {
  const d = new Date(takenAt);
  const hours24 = d.getHours();
  const hours =
    hours24 % HOURS_PER_HALF_DAY === 0 ? HOURS_PER_HALF_DAY : hours24 % HOURS_PER_HALF_DAY;
  const minutes = d.getMinutes();
  const meridiem = hours24 < HOURS_PER_HALF_DAY ? 'am' : 'pm';
  return `${hours}:${minutes < LEADING ? '0' : ''}${minutes} ${meridiem}`;
};

/** Second-level-ish label set we step over to reach the human word
 *  ("example.co.uk" → "example"). Deliberately tiny — this is a label heuristic,
 *  never a public-suffix engine. */
const STEP_OVER = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

const TWO_PART_DOMAIN = 2;
const SECOND_LEVEL_OFFSET = 2;
const THIRD_LEVEL_OFFSET = 3;
const labelWord = (domain: string): string => {
  const parts = domain
    .toLowerCase()
    .split('.')
    .filter((part) => part.length > 0);
  if (parts.length === 0) return domain;
  if (parts.length === 1) return parts[0] ?? domain;
  const secondLevel =
    parts.length >= TWO_PART_DOMAIN ? (parts.at(parts.length - SECOND_LEVEL_OFFSET) ?? '') : '';
  if (STEP_OVER.has(secondLevel) && parts.length > TWO_PART_DOMAIN) {
    return parts.at(parts.length - THIRD_LEVEL_OFFSET) ?? secondLevel;
  }
  return secondLevel.length > 0 ? secondLevel : (parts[0] ?? domain);
};

const WORD_LIMIT = 2;

/** The §6.1 honest label: "12 tabs · docs & time-tracking · 4:32 pm". */
export const buildHeuristicMissionName = (input: MissionNameInput): string => {
  const words = [...new Set(input.rootDomains.map(labelWord))].slice(0, WORD_LIMIT);
  const domainPart = words.length === 0 ? 'no domains' : words.join(' & ');
  const plural = input.tabCount === 1 ? 'tab' : 'tabs';
  return `${input.tabCount} ${plural} · ${domainPart} · ${formatLabelTime(input.takenAt)}`;
};

/** Rung-1 provider. Never rejects by content: the honest label is always
 *  constructible from ANY input (missing domains → "no domains"; the §6.11 low
 *  tier owns semantic shallowness, not this function). */
export const createHeuristicNamer = (): AiProviderPort => ({
  providerId: 'heuristic',
  modelClass: HEURISTIC_NAMER_MODEL_CLASS,
  capabilities: ['mission-name'],
  run: async (job: {
    readonly kind: AiJobKind;
    readonly subjectId: string;
    readonly value: unknown;
  }): Promise<Result<MemoryArtifactCandidate, LedgeError>> => {
    const raw = (job.value ?? {}) as Partial<MissionNameInput> & Readonly<Record<string, unknown>>;
    const input: MissionNameInput = {
      tabCount: typeof raw.tabCount === 'number' && raw.tabCount >= 0 ? raw.tabCount : 0,
      rootDomains: Array.isArray(raw.rootDomains)
        ? raw.rootDomains.filter((d): d is string => typeof d === 'string')
        : [],
      takenAt: typeof raw.takenAt === 'number' ? raw.takenAt : 0,
    };
    return ok({
      value: buildHeuristicMissionName(input),
      confidence: HEURISTIC_NAMER_CONFIDENCE,
      provider: 'heuristic',
      modelClass: HEURISTIC_NAMER_MODEL_CLASS,
      schemaV: 1,
    });
  },
});
