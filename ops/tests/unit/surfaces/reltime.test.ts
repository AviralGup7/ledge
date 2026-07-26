// E6-T01 · reltime util — the W7 card's {asOf} words (msg.time.*; clock fallback).
import { describe, expect, it } from 'vitest';
import { relTimeOf } from '@/surfaces/components/copy/reltime.js';
import { copyOf } from '@/surfaces/components/copy/copy.js';

const T0 = 1_785_400_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('E6-T01 reltime · calm asOf words', () => {
  it('just-now covers the first minute and future skew', () => {
    expect(relTimeOf(T0, T0)).toBe(copyOf('msg.time.just-now'));
    expect(relTimeOf(T0, T0 + MIN - 1)).toBe(copyOf('msg.time.just-now'));
    expect(relTimeOf(T0, T0 - MIN)).toBe(copyOf('msg.time.just-now')); // skew ⇒ calm
  });

  it('minutes and hours floor whole units (2 stays 2 until 3)', () => {
    expect(relTimeOf(T0, T0 + 2 * MIN)).toBe(copyOf('msg.time.minutes', { count: 2 }));
    expect(relTimeOf(T0, T0 + 3 * MIN - 1)).toBe(copyOf('msg.time.minutes', { count: 2 }));
    expect(relTimeOf(T0, T0 + HOUR)).toBe(copyOf('msg.time.hours', { count: 1 }));
    expect(relTimeOf(T0, T0 + DAY - 1)).toBe(copyOf('msg.time.hours', { count: 23 }));
  });

  it('beyond a day falls back to a locale clock (digits, no words)', () => {
    const rendered = relTimeOf(T0, T0 + DAY);
    expect(rendered).toMatch(/\d/);
    expect(rendered).not.toContain('before');
    expect(rendered).not.toContain('msg.');
  });
});
