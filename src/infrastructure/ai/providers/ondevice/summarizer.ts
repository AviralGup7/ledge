// E8-T04 · providers/ondevice — mission summarizer (Spec §6.3, Blueprint §6.15).
// The SAME verified model + evidence law as the namer (score.ts); new assembly:
// a one-liner (quiet-card surface) and a thread narrative (archive surface).
// Honesty laws this module keeps:
//  * FAIL-DOWN (the row's completion criterion): when evidence is thin the
//    calibrate floor answers null and this module YIELDS (never a low-fidelity
//    paragraph) — the ladder's heuristic counts form answers instead, with
//    name+counts remaining (§6.3 failure law).
//  * HONEST VOCABULARY (§5.13): every contentful token in both surfaces is
//    point-at-able — lexicon displays, kernel-confirmed terms, input domains,
//    counts, and the producer's name hint. No invented adjectives, ever.
//  * DETERMINISM: same input ⇒ same bytes (evidence sort is total; templates
//    are constant; no clocks beyond the producer's takenAt).
import {
  MISSION_SUMMARY_ONE_LINER_MAX_CHARS,
  type MissionSummaryInput,
} from '@/application/ports/ai-jobs.port.js';
import { formatLabelTime } from '../heuristic/labels.js';
import { buildMissionCorpus } from './corpus.js';
import type { OnDeviceModel } from './model-load.js';
import { calibrate, forwardPass, type CalibratedName, type FrameEvidence } from './score.js';

export type MissionSummaryOutcome =
  | {
      readonly status: 'named';
      readonly oneLiner: string;
      readonly thread: string;
      readonly confidence: number;
    }
  | { readonly status: 'yield' };

const TERMS_RECAP_MAX = 6;
const DOMAINS_RECAP_MAX = 3;

const oxfordJoin = (items: readonly string[]): string => {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
};

/** Evidence anchors: matched terms of the top frame (+ the dual mate, when the
 *  calibration law found one), order-stable, deduped, recap-capped. */
const recapTerms = (
  evidence: readonly FrameEvidence[],
  named: CalibratedName,
): readonly string[] => {
  const mateId = named.dualWith;
  const wanted = new Set([evidence[0]?.frameId ?? '', ...(mateId !== undefined ? [mateId] : [])]);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const frame of evidence) {
    if (!wanted.has(frame.frameId)) continue;
    for (const term of frame.matchedTerms) {
      if (seen.has(term)) continue;
      seen.add(term);
      if (terms.length < TERMS_RECAP_MAX) terms.push(term);
    }
  }
  return terms;
};

/**
 * One-liner assembly with the 120-char calm-card budget. The name + counts
 * always fit; evidence anchors are dropped from the TAIL when the budget
 * closes (dropping is honest — the anchors are a recap, never a claim).
 */
const assembleOneLiner = (
  named: CalibratedName,
  terms: readonly string[],
  domainCount: number,
): string => {
  const domainsPhrase =
    domainCount === 0
      ? 'no domains recorded'
      : `${domainCount} ${domainCount === 1 ? 'domain' : 'domains'}`;
  for (let take = terms.length; take >= 0; take -= 1) {
    const anchors = take === 0 ? '' : ` — anchors: ${oxfordJoin(terms.slice(0, take))}`;
    const line = `${named.value} — across ${domainsPhrase}${anchors}`;
    if (line.length <= MISSION_SUMMARY_ONE_LINER_MAX_CHARS) return line;
  }
  return `${named.value} — across ${domainsPhrase}`;
};

/** The archive thread: three template sentences, every token traceable. */
const assembleThread = (args: {
  readonly named: CalibratedName;
  readonly input: MissionSummaryInput;
  readonly domainCount: number;
  readonly terms: readonly string[];
}): string => {
  const { named, input, domainCount, terms } = args;
  const domainWord = domainCount === 1 ? 'domain' : 'domains';
  const first =
    domainCount === 0
      ? `This record covers ${input.tabCount} ${input.tabCount === 1 ? 'tab' : 'tabs'} with no domains on record.`
      : `This record covers ${input.tabCount} ${input.tabCount === 1 ? 'tab' : 'tabs'} across ${domainCount} ${domainWord}.`;
  const displays = named.value.slice(0, named.value.indexOf(' · ')); // the frame words, never the count tail
  const anchors =
    terms.length > 0 ? `, anchored by ${oxfordJoin(terms.slice(0, TERMS_RECAP_MAX))}` : '';
  const second = `The strongest evidence centers on ${displays}${anchors}.`;
  const domainsPreview = input.rootDomains.slice(0, DOMAINS_RECAP_MAX);
  const third =
    domainsPreview.length === 0
      ? `Parked record taken at ${formatLabelTime(input.takenAt)}.`
      : `Domains in play: ${domainsPreview.join(', ')} — parked at ${formatLabelTime(input.takenAt)}.`;
  const hint = input.missionNameHint;
  const nameLine = hint !== undefined && hint.length > 0 ? ` Name on record: ${hint}.` : '';
  return `${first} ${second} ${third}${nameLine}`;
};

/**
 * Produce the mission summary, or yield (the fail-down law made typed). The
 * input arrives producer-sanitized at the envelope, but providers stay total
 * over violations — caps are re-enforced here, never trusted.
 */
export const summarizeMission = (
  model: OnDeviceModel,
  input: MissionSummaryInput,
): MissionSummaryOutcome => {
  const corpus = buildMissionCorpus({ tabs: input.tabs, rootDomains: input.rootDomains });
  if (corpus.length === 0) return { status: 'yield' };
  const evidence = forwardPass(model.kernel, model.weights, corpus);
  const named = calibrate(evidence, input.tabCount);
  if (named === null) return { status: 'yield' };
  const terms = recapTerms(evidence, named);
  const domainCount = input.rootDomains.length;
  return {
    status: 'named',
    oneLiner: assembleOneLiner(named, terms, domainCount),
    thread: assembleThread({ named, input, domainCount, terms }),
    confidence: named.confidence,
  };
};
