// E3-T01 · ADR-032 binding — TabsPort contract suite against the in-memory fake chrome.
import { createChromeTabsAdapter } from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import { describeTabsPortContract, type TabsPortBinding } from './tabs-port.contract.js';

const FIRST_WINDOW = 1;

const binding: TabsPortBinding = (() => {
  const fake = createFakeChrome();
  return {
    makeAdapter: () => createChromeTabsAdapter({ api: fake.tabs }),
    seedTabs: async (n) => {
      const ids: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const t = await fake.tabs.create({ url: `https://seed.example/${i}`, active: false });
        ids.push(t.id ?? -1);
      }
      return ids;
    },
    drive: {
      update: (tabId, changes) => {
        fake.hooks.updateTab(tabId, changes);
      },
      activate: (tabId) => {
        fake.hooks.activateTab(tabId);
      },
    },
    sabotageNext: (cause) => {
      fake.hooks.sabotageNext(cause);
    },
    windowIdOfSeeded: () => FIRST_WINDOW,
  };
})();

describeTabsPortContract('fake-chrome', binding);
