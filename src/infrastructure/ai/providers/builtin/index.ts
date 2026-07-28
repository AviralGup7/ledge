// E8-T06 · providers/builtin — Chrome built-in AI adapter (ADR-018 rung 3:
// heuristic → OnDeviceML → BuiltIn → CloudDepth). Chrome's LanguageModel
// (Gemini-class, ON-DEVICE — zero egress by platform law) as the generative
// catch-net above the calibrated WASM rung: multilingual titles and free-text
// evidence the lexicon honestly yields on.
//
// LAWS THIS MODULE KEEPS (the row's completion criterion is #1):
//  * ABSENCE = INVISIBLE DEGRADE (K1): API missing, 'no'/'unavailable', or
//    merely DOWNLOADABLE ⇒ the factory answers null / the deferred rung
//    yields absent-typed forever. We NEVER trigger a model download (a
//    gigabyte background pull without consent is the opposite of calm), and
//    nothing anywhere banners, retries, or nags.
//  * SUGGESTED, NEVER ASSERTED (K2): generative output is UNCALIBRATED — no
//    logits exist to calibrate against. Every artifact stamps the frozen
//    BUILTIN_CONFIDENCE (the §6.11 MED floor ⇒ 'suggested' affordance):
//    honest posture — borrowable, never authoritative, never LOW (which
//    would neutralize the rung into uselessness), never HIGH (a lie).
//  * NO BRIEFS (E8-T05 J2 verbatim): capabilities are name + summary ONLY.
//    An uncalibrated generative brief is exactly the speculation-worded-
//    like-memory the absence-preference law bans; mission-brief resolves
//    zero rungs here and stays silent.
//  * SHAPE TRANSGRESSIONS ARE YIELDS (K4): an empty/overlong/instruction-
//    echoing/urgent answer is evidence quality, not a provider fault — the
//    ladder falls to the next rung WITHOUT a breaker strike; API faults
//    (session create/prompt rejecting) are ordinary provider-errors.
//  * DETECTION PER MOUNT (K3): availability is read once per composition
//    (memoized single-flight in the deferred rung); a later-completed
//    download joins on the next document/SW lifecycle — never by polling.
import {
  MISSION_SUMMARY_NAME_HINT_MAX_CHARS,
  MISSION_SUMMARY_ONE_LINER_MAX_CHARS,
  type AiJobKind,
  type MissionNameInput,
  type MissionSummaryInput,
} from '@/application/ports/ai-jobs.port.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { AiProviderPort } from '../../ladder.js';

export const BUILTIN_PROVIDER_ID = 'builtin';
/** §2.12 schema stamp for artifact payloads (rows schema-versioned by law). */
export const BUILTIN_ARTIFACT_SCHEMA_V = 1;
export const BUILTIN_MODEL_CLASS = 'chrome-builtin-lm-v1';
/** K2 frozen stamp (MED floor ⇒ 'suggested'): the uncalibrated-honesty
 *  constant — policy, pinned here, shadow-visible, ADR-noted. */
export const BUILTIN_CONFIDENCE = 0.6;
/** Calm-output budgets (the one-liner cap is the port's own; the name cap
 *  rides the mission-name envelope budget). */
const BUILTIN_NAME_BUDGET_WORDS = 12;

/** The platform slice this adapter depends on (Prompt API, document context).
 *  Injected by composition — the module never touches ambient browser state. */
export interface BuiltInSession {
  readonly prompt: (input: string) => Promise<string>;
  readonly destroy: () => void;
}
export interface BuiltInLanguageModel {
  readonly availability: (options?: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly create: (options?: Readonly<Record<string, unknown>>) => Promise<BuiltInSession>;
}
export interface BuiltInAiHost {
  readonly languageModel?: BuiltInLanguageModel | undefined;
}

/** Availability vocabularies, both Chrome generations, total over unknowns. */
const READY_WORDS: readonly string[] = ['readily', 'available'];
const DOWNLOAD_WORDS: readonly string[] = ['after-download', 'downloadable', 'downloading'];

export type BuiltInDetection = 'ready' | 'downloadable' | 'absent';

/** Capability detection, total (a rejecting or lying API is simply absent). */
export const detectBuiltIn = async (host: BuiltInAiHost): Promise<BuiltInDetection> => {
  const lm = host.languageModel;
  if (lm === undefined || typeof lm.availability !== 'function') return 'absent';
  try {
    const word = await lm.availability();
    if (READY_WORDS.includes(word)) return 'ready';
    if (DOWNLOAD_WORDS.includes(word)) return 'downloadable';
    return 'absent';
  } catch {
    return 'absent';
  }
};

// ── Envelope sanitation (mirrors the ondevice envelope law — the envelope is
//    trusted, but the provider never inverts the honesty law) ────────────────
const rawDomains = (raw: Readonly<Record<string, unknown>>): readonly string[] =>
  Array.isArray(raw['rootDomains'])
    ? (raw['rootDomains'] as unknown[]).filter((d): d is string => typeof d === 'string')
    : [];
const rawTabCount = (raw: Readonly<Record<string, unknown>>): number =>
  typeof raw['tabCount'] === 'number' && raw['tabCount'] >= 0 ? (raw['tabCount'] as number) : 0;
const rawTakenAt = (raw: Readonly<Record<string, unknown>>): number =>
  typeof raw['takenAt'] === 'number' ? (raw['takenAt'] as number) : 0;
const rawTabs = (raw: Readonly<Record<string, unknown>>): MissionNameInput['tabs'] | undefined =>
  Array.isArray(raw['tabs']) ? (raw['tabs'] as MissionNameInput['tabs']) : undefined;

/** Calm-shape law: prompt posture and enforcement budgets (named — the
 *  prompt's request and the post-check cap are the same vocabulary). */
const PROMPT_EVIDENCE_MAX_LINES = 24;
const NAME_PROMPT_WORDS = 6;
const SUMMARY_PROMPT_WORDS = 18;
const MIN_ANSWER_CHARS = 2;

/** Evidence lines for the prompt (the parked-tab privacy corpus law verbatim,
 *  one vocabulary across every rung): titles always contribute; a tab's
 *  rootDomain contributes only for LIVE tabs (discarded ⇒ title only); when
 *  no tab evidence exists the domain list itself is the evidence. */
const evidenceLines = (input: {
  readonly tabs?: MissionNameInput['tabs'] | undefined;
  readonly rootDomains: readonly string[];
}): readonly string[] => {
  const lines: string[] = [];
  for (const tab of input.tabs ?? []) {
    if (tab.title.length > 0) lines.push(tab.title);
    if (tab.discarded !== true && tab.rootDomain.length > 0) lines.push(tab.rootDomain);
  }
  if (lines.length === 0) lines.push(...input.rootDomains);
  return lines.slice(0, PROMPT_EVIDENCE_MAX_LINES);
};

/** Prompts: calm, constrained, single-purpose. The model is told the ONE
 *  shape we accept; the sanitizer below enforces it regardless. */
const namePrompt = (input: {
  readonly tabCount: number;
  readonly rootDomains: readonly string[];
  readonly tabs?: MissionNameInput['tabs'] | undefined;
  readonly missionNameHint?: string | undefined;
}): string => {
  const lines = evidenceLines(input);
  const hint =
    input.missionNameHint !== undefined && input.missionNameHint.length > 0
      ? `The user once called it: ${input.missionNameHint}. You may answer exactly that.`
      : '';
  return [
    `Name a group of ${input.tabCount} saved tabs for a calm tab manager.`,
    `Rules: answer with ONLY the name, at most ${NAME_PROMPT_WORDS} words, plain words, no punctuation, no quotes, no emoji, no exclamation.`,
    hint,
    'Tab titles and sites:',
    ...lines.map((line) => `- ${line}`),
    'Name:',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
};

const summaryPrompt = (input: MissionSummaryInput): string => {
  const lines = evidenceLines(input);
  const hint =
    input.missionNameHint !== undefined && input.missionNameHint.length > 0
      ? `The group is named: ${input.missionNameHint}.`
      : '';
  return [
    `Summarize what a group of ${input.tabCount} saved tabs is about, for a calm tab manager.`,
    `Rules: answer with ONE sentence, at most ${SUMMARY_PROMPT_WORDS} words, plain words, no exclamation, no quotes.`,
    hint,
    'Tab titles and sites:',
    ...lines.map((line) => `- ${line}`),
    'Summary:',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
};

// ── Output sanitation + shape law (K4) ───────────────────────────────────────
const WHITESPACE_RUN = /\s+/g;
/** Model chrome we never wear: wrapping quotes/backticks, list bullets, the
 *  colon-ended "Name:" echo, trailing sentence punctuation on a NAME. */
const WRAPPER_CHARS = /^[\s"'`•\-*>#]+|[\s"'`•\-*]+$/g;
const URGENCY_CHARS = /[!！]/g;

/** First line, unwrapped, whitespace-collapsed, urgency marks stripped. */
const sanitizeOutput = (raw: string): string =>
  (raw.split('\n')[0] ?? '')
    .replace(WRAPPER_CHARS, '')
    .replace(URGENCY_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();

/** Shape law: refuse echoes, placeholders, and content-free answers (a
 *  refusal is about CONTENT, not length — refuse means typed yield below). */
const PLACEHOLDER_WORDS: readonly string[] = [
  'untitled',
  'unknown',
  'name',
  'summary',
  'n/a',
  'none',
  'mission',
  'tabs',
];
const shapeOk = (text: string): boolean => {
  if (text.length < MIN_ANSWER_CHARS) return false;
  const lowered = text.toLowerCase();
  if (PLACEHOLDER_WORDS.includes(lowered)) return false;
  if (lowered.startsWith('rules:') || lowered.includes('answer with only')) return false;
  return true;
};

const capWords = (text: string, maxWords: number, maxChars: number): string => {
  const words = text.split(' ');
  const capped = words.length > maxWords ? words.slice(0, maxWords).join(' ') : text;
  return capped.slice(0, maxChars).trim();
};

const yieldNoConfidence = (why: string): LedgeError =>
  ledgeError('E_CAPABILITY', {
    provider: BUILTIN_PROVIDER_ID,
    yield: true,
    why,
  });

const capabilityAbsentYield = (why: string): LedgeError =>
  ledgeError('E_CAPABILITY', {
    provider: BUILTIN_PROVIDER_ID,
    yield: true,
    absent: true,
    why,
  });

/** One generative round: create → prompt → destroy (always destroyed; the
 *  session is per-job by design — no ambient state across missions). */
const generate = async (lm: BuiltInLanguageModel, promptText: string): Promise<string> => {
  const session = await lm.create({});
  try {
    return await session.prompt(promptText);
  } finally {
    try {
      session.destroy();
    } catch {
      // Destroy is best-effort hygiene; a borked teardown is not evidence.
    }
  }
};

const createProvider = (lm: BuiltInLanguageModel): AiProviderPort => ({
  providerId: BUILTIN_PROVIDER_ID,
  modelClass: BUILTIN_MODEL_CLASS,
  // K2/J2: name + summary only — briefs stay the calibrated rung's privilege.
  capabilities: ['mission-name', 'mission-summary'],
  run: async (job: {
    readonly kind: AiJobKind;
    readonly subjectId: string;
    readonly value: unknown;
  }): Promise<Result<MemoryArtifactCandidate, LedgeError>> => {
    const raw = (job.value ?? {}) as Readonly<Record<string, unknown>>;
    const hint = raw['missionNameHint'];
    const nameInput = {
      tabCount: rawTabCount(raw),
      rootDomains: rawDomains(raw),
      takenAt: rawTakenAt(raw),
      ...(rawTabs(raw) !== undefined ? { tabs: rawTabs(raw) } : {}),
      ...(typeof hint === 'string' && hint.length > 0
        ? { missionNameHint: hint.slice(0, MISSION_SUMMARY_NAME_HINT_MAX_CHARS) }
        : {}),
    };
    if (evidenceLines(nameInput).length === 0) return err(yieldNoConfidence('no-evidence'));
    const promptText =
      job.kind === 'mission-summary' ? summaryPrompt(nameInput) : namePrompt(nameInput);
    let answerRaw: string;
    try {
      answerRaw = await generate(lm, promptText);
    } catch {
      // API fault (create/prompt rejected): ordinary provider error — the
      // ladder's retry economics apply; NOT a yield (not evidence quality).
      return err(
        ledgeError('E_PROVIDER_DOWN', {
          provider: BUILTIN_PROVIDER_ID,
          what: 'session-failed',
          retryable: true,
        }),
      );
    }
    const text = sanitizeOutput(answerRaw);
    if (!shapeOk(text)) return err(yieldNoConfidence('shape-refused'));
    const value =
      job.kind === 'mission-summary'
        ? capWords(text, SUMMARY_PROMPT_WORDS, MISSION_SUMMARY_ONE_LINER_MAX_CHARS)
        : capWords(text, BUILTIN_NAME_BUDGET_WORDS, MISSION_SUMMARY_NAME_HINT_MAX_CHARS);
    if (!shapeOk(value)) return err(yieldNoConfidence('shape-refused'));
    return ok({
      value,
      confidence: BUILTIN_CONFIDENCE,
      provider: BUILTIN_PROVIDER_ID,
      modelClass: BUILTIN_MODEL_CLASS,
      schemaV: BUILTIN_ARTIFACT_SCHEMA_V,
    });
  },
});

/**
 * Capability-detected factory (K1): 'ready' answers the provider; 'absent'
 * AND 'downloadable' answer null — the invisible degrade, identical bytes to
 * the user either way.
 */
export const createBuiltInNamer = async (host?: BuiltInAiHost): Promise<AiProviderPort | null> => {
  const resolved: BuiltInAiHost = host ?? {
    languageModel: (globalThis as { LanguageModel?: BuiltInLanguageModel }).LanguageModel,
  };
  const detection = await detectBuiltIn(resolved);
  if (detection !== 'ready' || resolved.languageModel === undefined) return null;
  return createProvider(resolved.languageModel);
};

/**
 * DEFERRED rung for synchronous composition (mirrors the ondevice deferred
 * law): detection runs single-flight on first use; absent/downloadable yield
 * absent-typed forever (no strike, no banner), and the ai-lanes probe keeps
 * the rung's breaker cell as evidence. detection is re-attempted each mount,
 * never polled within one.
 */
export const createDeferredBuiltInNamer = (host?: BuiltInAiHost): AiProviderPort => {
  const resolved: BuiltInAiHost = host ?? {
    languageModel: (globalThis as { LanguageModel?: BuiltInLanguageModel }).LanguageModel,
  };
  let settled: Promise<BuiltInDetection> | null = null;
  const detect = (): Promise<BuiltInDetection> => {
    settled ??= detectBuiltIn(resolved);
    return settled;
  };
  return {
    providerId: BUILTIN_PROVIDER_ID,
    modelClass: BUILTIN_MODEL_CLASS,
    capabilities: ['mission-name', 'mission-summary'],
    run: async (job) => {
      const detection = await detect();
      if (detection !== 'ready' || resolved.languageModel === undefined) {
        return err(capabilityAbsentYield(detection));
      }
      return createProvider(resolved.languageModel).run(job);
    },
  };
};
