// E8-T05 · providers/ondevice — resumption briefs (Spec §6.9, W5). A brief is
// two-three template sentences: the state you left, where you stopped, what is
// pending — every token traceable (calibrated frame words, counts, or a
// producer hint carried verbatim). The ABSENCE-PREFERENCE law is the row's
// completion criterion:
//  * evidence below the SAME calibration floor as naming ⇒ typed YIELD, and
//    briefs have NO heuristic rung by design — the host maps a pure-yield
//    attempt to lawful silence (never a fallback paragraph of counts worded
//    like a memory);
//  * a state sentence alone is NOT a brief (it is the §6.3 one-liner restated):
//    without at least one of "where you stopped" / "what is pending" this
//    module yields — absence preferred to invention (§6.9 failure law);
//  * hints are never completed, padded, or adorned — capped punctuation-clean
//    verbatim, and budget pressure truncates at word boundaries (recap-drop
//    honesty, the summarizer's tail-drop law in prose).
import {
  MISSION_BRIEF_LAST_ACTIVE_MAX_CHARS,
  MISSION_BRIEF_MAX_CHARS,
  MISSION_BRIEF_PENDING_MAX_CHARS,
  MISSION_SUMMARY_NAME_HINT_MAX_CHARS,
  type MissionBriefInput,
} from '@/application/ports/ai-jobs.port.js';
import { buildMissionCorpus } from './corpus.js';
import type { OnDeviceModel } from './model-load.js';
import { calibrate, forwardPass, type CalibratedName } from './score.js';

export type MissionBriefOutcome =
  | {
      readonly status: 'brief';
      readonly text: string;
      readonly confidence: number;
    }
  | { readonly status: 'yield' };

/** Below this many surviving chars a truncated hint is noise — drop the
 *  sentence instead of wearing a fragment (recap-drop honesty). */
const MIN_HINT_KEEP_CHARS = 40;

/** Verbatim carries whitespace-collapsed, never reworded (titles arrive with
 *  tabs/newlines from hostile pages; the brief is a calm card, one line per
 *  sentence). */
const WHITESPACE_RUN = /\s+/g;
const sanitizeHint = (raw: string, cap: number): string =>
  raw.replace(WHITESPACE_RUN, ' ').trim().slice(0, cap);

/** Hard budget enforcement: cut at the last word boundary inside the budget;
 *  no ellipsis (a cut recap is honest; an invented flourish is not). */
const truncateAtWord = (text: string, budget: number): string => {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
};

/** The mission's name for the state sentence: the producer's hint verbatim
 *  when present, else the calibrated frame words (the count tail "· N tabs"
 *  belongs to cards, never to prose). */
const briefName = (named: CalibratedName, hint: string | undefined): string => {
  if (hint !== undefined && hint.length > 0) return hint;
  const tail = named.value.indexOf(' · ');
  return tail > 0 ? named.value.slice(0, tail) : named.value;
};

const stateSentence = (name: string, input: MissionBriefInput): string => {
  const tabs = `${input.tabCount} ${input.tabCount === 1 ? 'tab' : 'tabs'}`;
  const domains = input.rootDomains.length;
  if (domains === 0) return `You left ${name} with ${tabs}.`;
  return `You left ${name} with ${tabs} across ${domains} ${domains === 1 ? 'domain' : 'domains'}.`;
};

const stoppedSentence = (lastActiveTitle: string): string => `You stopped at ${lastActiveTitle}.`;
const pendingSentence = (pendingNote: string): string => `Pending: ${pendingNote}.`;
/** Template overheads (derived, never literal — the template IS the budget law). */
const STOPPED_TEMPLATE_CHARS = stoppedSentence('').length;
const PENDING_TEMPLATE_CHARS = pendingSentence('').length;
const SENTENCE_GAP_CHARS = 1;

/** Join the sentences under the calm-card budget; pressure absorbs into the
 *  pending hint first, then the stopped hint (word-boundary truncation), then
 *  drops a too-fragmented sentence (never below the two-sentence floor — that
 *  case is unreachable in arithmetic and asserted by the suite). `stopped` /
 *  `pending` arrive RAW (never pre-wrapped — truncation must cut the hint,
 *  not the template). */
const assembleBrief = (args: {
  readonly state: string;
  readonly stopped?: string | undefined;
  readonly pending?: string | undefined;
}): string => {
  const stoppedText = args.stopped !== undefined ? stoppedSentence(args.stopped) : undefined;
  const sentences = [args.state];
  if (stoppedText !== undefined) sentences.push(stoppedText);
  if (args.pending !== undefined) sentences.push(pendingSentence(args.pending));
  let text = sentences.join(' ');
  if (text.length <= MISSION_BRIEF_MAX_CHARS) return text;
  if (args.pending !== undefined) {
    const others = [args.state, ...(stoppedText !== undefined ? [stoppedText] : [])].join(' ');
    const budget = MISSION_BRIEF_MAX_CHARS - others.length - SENTENCE_GAP_CHARS;
    if (budget >= MIN_HINT_KEEP_CHARS + PENDING_TEMPLATE_CHARS) {
      const kept = truncateAtWord(args.pending, budget - PENDING_TEMPLATE_CHARS);
      text = `${others} ${pendingSentence(kept)}`;
      if (text.length <= MISSION_BRIEF_MAX_CHARS) return text;
    }
    text = others;
    if (text.length <= MISSION_BRIEF_MAX_CHARS) return text;
  }
  if (args.stopped !== undefined) {
    const budget = MISSION_BRIEF_MAX_CHARS - args.state.length - SENTENCE_GAP_CHARS;
    if (budget >= MIN_HINT_KEEP_CHARS + STOPPED_TEMPLATE_CHARS) {
      const kept = truncateAtWord(args.stopped, budget - STOPPED_TEMPLATE_CHARS);
      return `${args.state} ${stoppedSentence(kept)}`;
    }
  }
  return args.state;
};

/**
 * Produce the resumption brief, or yield (absence preferred to invention).
 * The input arrives producer-sanitized at the envelope; providers stay total
 * over violations — caps are re-enforced here, never trusted.
 */
export const buildMissionBrief = (
  model: OnDeviceModel,
  input: MissionBriefInput,
): MissionBriefOutcome => {
  const corpus = buildMissionCorpus({ tabs: input.tabs, rootDomains: input.rootDomains });
  if (corpus.length === 0) return { status: 'yield' };
  const evidence = forwardPass(model.kernel, model.weights, corpus);
  const named = calibrate(evidence, input.tabCount);
  if (named === null) return { status: 'yield' };
  const lastActive =
    input.lastActiveTitle !== undefined
      ? sanitizeHint(input.lastActiveTitle, MISSION_BRIEF_LAST_ACTIVE_MAX_CHARS)
      : '';
  const pending =
    input.pendingNote !== undefined
      ? sanitizeHint(input.pendingNote, MISSION_BRIEF_PENDING_MAX_CHARS)
      : '';
  // §6.9 shape law: two-three sentences. State alone is a summary, not a
  // brief — absence preferred (the absence-preference terminal answers).
  if (lastActive.length === 0 && pending.length === 0) return { status: 'yield' };
  const nameHint =
    input.missionNameHint !== undefined
      ? sanitizeHint(input.missionNameHint, MISSION_SUMMARY_NAME_HINT_MAX_CHARS)
      : undefined;
  const text = assembleBrief({
    state: stateSentence(briefName(named, nameHint), input),
    ...(lastActive.length > 0 ? { stopped: lastActive } : {}),
    ...(pending.length > 0 ? { pending } : {}),
  });
  return { status: 'brief', text, confidence: named.confidence };
};
