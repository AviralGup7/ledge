// E8-T04 · providers/heuristic — the rung-1 label vocabulary, extracted so the
// naming surface (namer.ts) and the §6.3 summary surface (summarizer.ts) share
// ONE law without an import cycle (depcruise no-circular). namer.ts re-exports
// both to keep its E8-T01 public surface byte-stable.

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
export const labelWord = (domain: string): string => {
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
