// E8-T04 · mission corpus assembly (extracted from the namer so the summarizer
// shares the exact evidence-building law — drift between namer and summarizer
// corpus would grade the same mission two ways).
// Laws: titles always contribute; rootDomain contributes only for live tabs
// (discarded ⇒ title only, parked-tab privacy — same as the namer); when no tab
// evidence exists at all the domain list itself is the corpus; NFKD/diacritic/
// case normalization is the JS side of the kernel boundary law (score.ts).
import type { MissionNameTab } from '@/application/ports/ai-jobs.port.js';
import { normalizeText } from './score.js';

export interface MissionCorpusParts {
  readonly tabs?: readonly MissionNameTab[] | undefined;
  readonly rootDomains: readonly string[];
}

/** The normalized evidence corpus for one mission; '' means "no evidence". */
export const buildMissionCorpus = (parts: MissionCorpusParts): string => {
  const segments: string[] = [];
  const tabs = parts.tabs ?? [];
  for (const tab of tabs) {
    if (tab.title.length > 0) segments.push(tab.title);
    if (tab.discarded !== true && tab.rootDomain.length > 0) segments.push(tab.rootDomain);
  }
  if (segments.length === 0) segments.push(...parts.rootDomains);
  return normalizeText(segments.join(' '));
};
