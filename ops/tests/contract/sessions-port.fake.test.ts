// E3-T03 · ADR-032 binding — NativeSessionsPort contract suite against the
// in-memory fake (sessions seam + seeded backlog + one-shot sabotage).
import { createChromeSessionsAdapter } from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import {
  describeSessionsPortContract,
  type SessionsPortBinding,
} from './sessions-port.contract.js';

const binding: SessionsPortBinding = (() => {
  const fake = createFakeChrome();
  return {
    makeAdapter: () => createChromeSessionsAdapter({ api: fake.sessions }),
    seedRecentlyClosed: (sessions) => {
      fake.hooks.seedRecentlyClosed(sessions);
    },
    sabotageNext: (cause) => {
      fake.hooks.sabotageSessionsNext(cause);
    },
  };
})();

describeSessionsPortContract('fake-chrome', binding);
