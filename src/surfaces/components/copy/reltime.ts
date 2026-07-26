// E6-T01 · Relative-time words for the W7 card's {asOf} (W7 copy: "as of 2 min
// before"). Words live in the catalog (msg.time.*); beyond a day we hand back a
// locale clock string (digits are formatting, not lexicon, §2 copy law). Skew
// (a future stamp) reads as just-now — calm beats precise-but-alarming.
import { copyOf } from './copy.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const relTimeOf = (ts: number, now: number = Date.now()): string => {
  const delta = now - ts;
  if (delta < MINUTE_MS) return copyOf('msg.time.just-now');
  if (delta < HOUR_MS) return copyOf('msg.time.minutes', { count: Math.floor(delta / MINUTE_MS) });
  if (delta < DAY_MS) return copyOf('msg.time.hours', { count: Math.floor(delta / HOUR_MS) });
  return new Date(ts).toLocaleTimeString();
};
