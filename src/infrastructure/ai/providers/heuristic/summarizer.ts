// E8-T04 · providers/heuristic — the Spec §6.3 shallow-summary form, rung 1.
// Fail-down law made constructive: when the on-device evidence is thin (typed
// yield), the mission keeps its NAME + COUNTS and nothing fabricates depth.
// Same vocabulary ceiling as the naming rung — domains/label words, counts,
// time (titles are never read by a heuristic-run artifact; parked-tab privacy
// mirrors the on-device corpus law: discarded tabs contribute to `tabCount`
// only, never to the domain tallies).
import {
  MISSION_SUMMARY_ONE_LINER_MAX_CHARS,
  type MissionSummaryInput,
} from '@/application/ports/ai-jobs.port.js';
import { formatLabelTime, labelWord } from './labels.js';

export interface HeuristicMissionSummary {
  readonly oneLiner: string;
  readonly thread: string;
}

const SINGLE_TAB = 1;

/** Presence tallies per label word (live tabs when given; else the domain list). */
const presenceOf = (input: MissionSummaryInput): ReadonlyMap<string, number> => {
  const tally = new Map<string, number>();
  const tabs = input.tabs;
  if (tabs !== undefined) {
    for (const tab of tabs) {
      if (tab.discarded === true || tab.rootDomain.length === 0) continue;
      const word = labelWord(tab.rootDomain);
      tally.set(word, (tally.get(word) ?? 0) + 1);
    }
    return tally;
  }
  for (const domain of input.rootDomains) {
    const word = labelWord(domain);
    tally.set(word, (tally.get(word) ?? 0) + 1);
  }
  return tally;
};

const assembleOneLiner = (
  input: MissionSummaryInput,
  domainCount: number,
  top: { readonly word: string; readonly count: number } | null,
): string => {
  const tabWord = input.tabCount === SINGLE_TAB ? 'tab' : 'tabs';
  const time = formatLabelTime(input.takenAt);
  const base =
    domainCount === 0
      ? `${input.tabCount} ${tabWord} · no domains · ${time}`
      : `${input.tabCount} ${tabWord} across ${domainCount} ${domainCount === SINGLE_TAB ? 'domain' : 'domains'}`;
  const presence =
    top !== null
      ? `, largest presence ${top.word} (${top.count} ${top.count === SINGLE_TAB ? 'tab' : 'tabs'})`
      : '';
  const full = `${base}${presence} · ${time}`;
  const hintPrefix =
    input.missionNameHint !== undefined && input.missionNameHint.length > 0
      ? `${input.missionNameHint} — `
      : '';
  // Budget law: drop the presence clause, then the time, then the hint (the
  // hint is additive garnish — dropping it is honest; slicing mid-word is not).
  // The bare counts line is ~30 chars and always fits.
  const candidates = [
    `${hintPrefix}${full}`,
    `${hintPrefix}${base} · ${time}`,
    `${hintPrefix}${base}`,
    `${base} · ${time}`,
    base,
  ];
  return candidates.find((line) => line.length <= MISSION_SUMMARY_ONE_LINER_MAX_CHARS) ?? base;
};

const assembleThread = (
  input: MissionSummaryInput,
  domainCount: number,
  top: { readonly word: string; readonly count: number } | null,
  words: readonly string[],
): string => {
  const first =
    domainCount === 0
      ? `This ${input.tabCount}-tab record has no domains on record.`
      : `This ${input.tabCount}-tab record spans ${domainCount} ${domainCount === SINGLE_TAB ? 'domain' : 'domains'}.`;
  const second =
    top !== null
      ? `Domain family ${top.word} appears most (${top.count} ${top.count === SINGLE_TAB ? 'tab' : 'tabs'}).`
      : words.length > 0
        ? `Domains in play: ${words.join(', ')}.`
        : '';
  const third = `Parked at ${formatLabelTime(input.takenAt)}.`;
  const hint =
    input.missionNameHint !== undefined && input.missionNameHint.length > 0
      ? ` Name on record: ${input.missionNameHint}.`
      : '';
  return [first, second, `${third}${hint}`].filter((s) => s.length > 0).join(' ');
};

/** The §6.3 count-level summary: always constructible, always calm, never deep. */
export const buildHeuristicMissionSummary = (
  input: MissionSummaryInput,
): HeuristicMissionSummary => {
  const presence = presenceOf(input);
  let top: { readonly word: string; readonly count: number } | null = null;
  for (const [word, count] of presence) {
    if (top === null || count > top.count || (count === top.count && word < top.word)) {
      top = { word, count };
    }
  }
  const words = [...presence.keys()];
  return {
    oneLiner: assembleOneLiner(input, presence.size, top),
    thread: assembleThread(input, presence.size, top, words),
  };
};
