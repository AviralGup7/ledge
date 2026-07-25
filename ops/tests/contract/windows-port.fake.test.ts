// E3-T01 · ADR-032 binding — WindowsPort contract suite against the in-memory fake.
import {
  createChromeTabsAdapter,
  createChromeWindowsAdapter,
} from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import { describeWindowsPortContract, type WindowsPortBinding } from './windows-port.contract.js';

const binding: WindowsPortBinding = (() => {
  const fake = createFakeChrome();
  return {
    makeAdapter: () => createChromeWindowsAdapter({ api: fake.windows }),
    makeTabsAdapter: () => createChromeTabsAdapter({ api: fake.tabs }),
    sabotageNext: (cause) => {
      fake.hooks.sabotageNext(cause);
    },
    openTwoWindows: async () => {
      const a = await fake.windows.create({ url: ['https://a.example'], focused: false });
      const b = await fake.windows.create({ url: ['https://b.example'], focused: false });
      return [a.id ?? -1, b.id ?? -1];
    },
  };
})();

describeWindowsPortContract('fake-chrome', binding);
