// E8-T03 · providers/ondevice — ladder rung 2 (ADR-018 chain: heuristic →
// OnDeviceML → BuiltIn → CloudDepth), the WASM forward-pass namer living in the
// workroom per Blueprint §9 row 7 (SW-local execution remains legal — the model
// is stateless bytes, capability-detected identically in both contexts).
//
// LAWS THIS MODULE KEEPS:
//  * CAPABILITY-DETECTED (matrix): absent WebAssembly / bad bytes / layout
//    violation ⇒ the factory answers null and composition simply does not
//    register the rung — invisible degrade, no banner, no retry loop.
//  * YIELD-DON'T-FAKE (fail-down, ADR-018): evidence below the calibration floor
//    is a typed YIELD (code E_CAPABILITY, details.yield=true, retryable:false),
//    never an artifact. Hosts pass yields through WITHOUT a breaker strike —
//    thin evidence is not a provider fault. The ladder's next rung (heuristic)
//    answers with its honest label instead.
//  * HONEST VOCABULARY (§5.13): names assemble from lexicon display words +
//    tabCount only — the model never emits tokens it cannot point to in the
//    weight table; non-English corpora score nothing and yield.
//  * ISOLATION (ADR-041 / E8-T02 lint): zero imports of mutation-capable
//    portraits; the provider's only output type is MemoryArtifactCandidate.
import {
  MISSION_BRIEF_LAST_ACTIVE_MAX_CHARS,
  MISSION_BRIEF_PENDING_MAX_CHARS,
  MISSION_SUMMARY_NAME_HINT_MAX_CHARS,
  type AiJobKind,
  type MissionBriefInput,
  type MissionNameInput,
  type MissionSummaryInput,
} from '@/application/ports/ai-jobs.port.js';
import type { MemoryArtifactCandidate } from '@/domain/memory/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { AiProviderPort } from '../../ladder.js';
import { buildMissionBrief } from './briefs.js';
import { buildMissionCorpus } from './corpus.js';
import { MODEL_CLASS } from './model-layout.js';
import { loadOnDeviceModel, type OnDeviceModel, type OnDeviceModelHost } from './model-load.js';
import { calibrate, forwardPass, ONDEVICE_MODEL_V } from './score.js';
import { summarizeMission } from './summarizer.js';

export { MODEL_CLASS, ONDEVICE_MODEL_V };
export type { OnDeviceModelHost } from './model-load.js';

export const ONDEVICE_PROVIDER_ID = 'ondevice';
/** §2.12 schema stamp for artifact payloads (rows schema-versioned by law). */
export const ONDEVICE_ARTIFACT_SCHEMA_V = 1;
export const ONDEVICE_YIELD_REASON = 'insufficient-evidence';

/** A typed YIELD — hosts skip breaker accounting for exactly this shape. */
export const isOnDeviceYield = (error: LedgeError): boolean =>
  error.code === 'E_CAPABILITY' && error.details?.['yield'] === true;

const yieldNoConfidence = (): LedgeError =>
  ledgeError('E_CAPABILITY', {
    provider: ONDEVICE_PROVIDER_ID,
    yield: true,
    why: ONDEVICE_YIELD_REASON,
  });

/** Envelope sanitation, shared by both capabilities (total over violations —
 *  the envelope is trusted, but the provider never inverts the honesty law). */
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

const createProviderFromModel = (model: OnDeviceModel): AiProviderPort => ({
  providerId: ONDEVICE_PROVIDER_ID,
  modelClass: MODEL_CLASS,
  capabilities: ['mission-name', 'mission-summary', 'mission-brief'],
  run: async (job: {
    readonly kind: AiJobKind;
    readonly subjectId: string;
    readonly value: unknown;
  }): Promise<Result<MemoryArtifactCandidate, LedgeError>> => {
    const raw = (job.value ?? {}) as Readonly<Record<string, unknown>>;
    if (job.kind === 'mission-brief') {
      // E8-T05 (Spec §6.9): briefs share the naming evidence law AND the same
      // calibration floor — below it the provider yields and, with no heuristic
      // rung by design, the host answers lawful silence (absence preference).
      const hint = raw['missionNameHint'];
      const lastActive = raw['lastActiveTitle'];
      const pending = raw['pendingNote'];
      const input: MissionBriefInput = {
        tabCount: rawTabCount(raw),
        rootDomains: rawDomains(raw),
        takenAt: rawTakenAt(raw),
        ...(rawTabs(raw) !== undefined ? { tabs: rawTabs(raw) } : {}),
        ...(typeof hint === 'string' && hint.length > 0
          ? { missionNameHint: hint.slice(0, MISSION_SUMMARY_NAME_HINT_MAX_CHARS) }
          : {}),
        ...(typeof lastActive === 'string' && lastActive.length > 0
          ? { lastActiveTitle: lastActive.slice(0, MISSION_BRIEF_LAST_ACTIVE_MAX_CHARS) }
          : {}),
        ...(typeof pending === 'string' && pending.length > 0
          ? { pendingNote: pending.slice(0, MISSION_BRIEF_PENDING_MAX_CHARS) }
          : {}),
      };
      const brief = buildMissionBrief(model, input);
      if (brief.status === 'yield') return err(yieldNoConfidence());
      return ok({
        value: brief.text,
        confidence: brief.confidence,
        provider: ONDEVICE_PROVIDER_ID,
        modelClass: MODEL_CLASS,
        schemaV: ONDEVICE_ARTIFACT_SCHEMA_V,
      });
    }
    if (job.kind === 'mission-summary') {
      // E8-T04 (Spec §6.3): the summary shares the naming evidence law; thin
      // evidence yields typed and the ladder falls to the heuristic form.
      const hint = raw['missionNameHint'];
      const input: MissionSummaryInput = {
        tabCount: rawTabCount(raw),
        rootDomains: rawDomains(raw),
        takenAt: rawTakenAt(raw),
        ...(rawTabs(raw) !== undefined ? { tabs: rawTabs(raw) } : {}),
        ...(typeof hint === 'string' && hint.length > 0
          ? { missionNameHint: hint.slice(0, MISSION_SUMMARY_NAME_HINT_MAX_CHARS) }
          : {}),
      };
      const summary = summarizeMission(model, input);
      if (summary.status === 'yield') return err(yieldNoConfidence());
      return ok({
        value: summary.oneLiner,
        confidence: summary.confidence,
        provider: ONDEVICE_PROVIDER_ID,
        modelClass: MODEL_CLASS,
        schemaV: ONDEVICE_ARTIFACT_SCHEMA_V,
        thread: summary.thread,
      });
    }
    const input: MissionNameInput = {
      tabCount: rawTabCount(raw),
      rootDomains: rawDomains(raw),
      takenAt: rawTakenAt(raw),
      ...(rawTabs(raw) !== undefined ? { tabs: rawTabs(raw) } : {}),
    };
    const corpus = buildMissionCorpus(input);
    if (corpus.length === 0) return err(yieldNoConfidence());
    const evidence = forwardPass(model.kernel, model.weights, corpus);
    const named = calibrate(evidence, input.tabCount);
    if (named === null) return err(yieldNoConfidence());
    return ok({
      value: named.value,
      confidence: named.confidence,
      provider: ONDEVICE_PROVIDER_ID,
      modelClass: MODEL_CLASS,
      schemaV: ONDEVICE_ARTIFACT_SCHEMA_V,
    });
  },
});

const capabilityAbsentYield = (cause: LedgeError): LedgeError =>
  ledgeError('E_CAPABILITY', {
    provider: ONDEVICE_PROVIDER_ID,
    yield: true,
    absent: true,
    why: cause.details?.['what'] ?? cause.code,
  });

/**
 * Capability-detected factory: answers the provider, or null when the model
 * cannot load (invisible degrade law — composition registers one rung fewer).
 * Memoized per graph: model load is verified bytes + one instantiation.
 */
export const createOnDeviceNamer = async (
  host?: OnDeviceModelHost,
): Promise<AiProviderPort | null> => {
  const resolved: OnDeviceModelHost = host ?? {
    hasWebAssembly: typeof WebAssembly !== 'undefined',
  };
  const loaded = await loadOnDeviceModel(resolved);
  if (!loaded.ok) return null;
  return createProviderFromModel(loaded.value);
};

/**
 * DEFERRED rung for synchronous composition (roots law: graphs compose sync;
 * capability detection is async). The registered provider resolves the model
 * single-flight on first use; capability absence answers a typed YIELD forever
 * (details.yield=true — hosts never strike the breaker), which is the invisible
 * degrade expressed inside the sync-composition contract. The ai-lanes probe
 * keeps showing the rung's breaker cell (evidence, never a banner).
 */
export const createDeferredOnDeviceNamer = (host?: OnDeviceModelHost): AiProviderPort => {
  const resolvedHost: OnDeviceModelHost = host ?? {
    hasWebAssembly: typeof WebAssembly !== 'undefined',
  };
  let settled: Promise<Result<OnDeviceModel, LedgeError>> | null = null;
  const load = (): Promise<Result<OnDeviceModel, LedgeError>> => {
    settled ??= loadOnDeviceModel(resolvedHost);
    return settled;
  };
  return {
    providerId: ONDEVICE_PROVIDER_ID,
    modelClass: MODEL_CLASS,
    capabilities: ['mission-name', 'mission-summary', 'mission-brief'],
    run: async (job) => {
      const model = await load();
      if (!model.ok) return err(capabilityAbsentYield(model.error));
      return createProviderFromModel(model.value).run(job);
    },
  };
};
