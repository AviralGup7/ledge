// E3-T01 · ADR-032 binding — TabsPort contract suite against REFERENCE CHROME.
// Runs only inside browser CI lanes (CHROME_LANE=1 env with a real `chrome`
// global): the E3-T01 completion criterion is this suite green on Chrome stable
// and beta. Node CI skips it entirely.
import { describe, it } from 'vitest';
import { createChromeTabsAdapter } from '@/infrastructure/chrome/index.js';
import { describeTabsPortContract, type TabsPortBinding } from './tabs-port.contract.js';

const IN_CHROME_LANE = process.env['CHROME_LANE'] === '1' && typeof chrome !== 'undefined';

const binding = (): TabsPortBinding => {
  let seededWindowId = -1;
  return {
    makeAdapter: () => createChromeTabsAdapter(),
    seedTabs: async (n) => {
      const current = await chrome.windows.getCurrent();
      seededWindowId = current.id ?? -1;
      const ids: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const created = await chrome.tabs.create({ url: 'about:blank', active: false });
        ids.push(created.id ?? -1);
      }
      return ids;
    },
    drive: null, // reference-Chrome drive hooks (tabs.update scripting) wire in-lane
    sabotageNext: null,
    windowIdOfSeeded: () => seededWindowId,
  };
};

(IN_CHROME_LANE ? describe : describe.skip)('chrome lane presence', () => {
  it('binds real chrome.tabs', () => {
    expect(typeof chrome.tabs.query).toBe('function');
  });
});

if (IN_CHROME_LANE) {
  describeTabsPortContract('chrome-reference', binding());
}
