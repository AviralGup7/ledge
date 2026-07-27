// E3-T07 · ADR-032 binding — OffscreenPort contract suite against REFERENCE
// CHROME. Runs only inside browser CI lanes (CHROME_LANE=1 with a real `chrome`
// global); node CI skips it entirely, matching the E3-T01/T03 lane pattern. The
// offscreen document is SHARED browser state for the whole session (one doc max),
// and this lane may run beside an extension build that itself spawns a workroom —
// so the reference run proves presence/capability/ensure-adoption only; the
// spawn-once, race, race-kill, and drift laws are carried by the fake binding,
// and the real spawn+kill exactly-once rehearsal is the E8 e2e lane's scope.
import { describe, expect, it } from 'vitest';
import { createChromeOffscreenAdapter } from '@/infrastructure/chrome/index.js';

const IN_CHROME_LANE = process.env['CHROME_LANE'] === '1' && typeof chrome !== 'undefined';

(IN_CHROME_LANE ? describe : describe.skip)('offscreen chrome lane presence', () => {
  it('binds real chrome.offscreen and reports capability', () => {
    const adapter = createChromeOffscreenAdapter();
    const cap = adapter.capability();
    expect(cap.ok).toBe(true);
    if (cap.ok) {
      expect(cap.value.apiPresent).toBe(true);
      expect(Object.keys(cap.value.reasonTable)).toContain('ai-jobs');
    }
  });

  it('observes document presence honestly and adopts without error', async () => {
    const adapter = createChromeOffscreenAdapter();
    const before = await adapter.hasDocument();
    expect(before.ok).toBe(true);
    const ensured = await adapter.ensureDocument({ spawnClass: 'ai-jobs' });
    expect(ensured.ok).toBe(true);
    const after = await adapter.hasDocument();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toBe(true);
  });
});
