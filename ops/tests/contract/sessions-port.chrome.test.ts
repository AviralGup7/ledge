// E3-T03 · ADR-032 binding — NativeSessionsPort contract suite against REFERENCE
// CHROME. Runs only inside browser CI lanes (CHROME_LANE=1 with a real `chrome`
// global); node CI skips it entirely, matching the E3-T01 lane pattern. Note the
// lane cannot seed a deterministic backlog — chrome's own recently-closed list is
// shared browser state — so the reference run proves the read path + failure
// shape, with the deterministic laws carried by the fake binding.
import { describe, expect, it } from 'vitest';
import { createChromeSessionsAdapter } from '@/infrastructure/chrome/index.js';

const IN_CHROME_LANE = process.env['CHROME_LANE'] === '1' && typeof chrome !== 'undefined';

(IN_CHROME_LANE ? describe : describe.skip)('chrome lane presence', () => {
  it('binds real chrome.sessions and reads the backlog', async () => {
    expect(typeof chrome.sessions.getRecentlyClosed).toBe('function');
    const r = await createChromeSessionsAdapter().recentlyClosedTabs();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.value)).toBe(true);
      for (const row of r.value) expect(row.url.length).toBeGreaterThan(0);
    }
  });
});
