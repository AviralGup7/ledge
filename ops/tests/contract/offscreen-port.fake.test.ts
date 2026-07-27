// E3-T07 · ADR-032 binding — OffscreenPort contract suite against the in-memory
// fake (presence flag + create-parameter capture + scoped one-shot sabotage seams).
import { createChromeOffscreenAdapter } from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import {
  describeOffscreenPortContract,
  type OffscreenPortBinding,
} from './offscreen-port.contract.js';

const binding: OffscreenPortBinding = (() => {
  const fake = createFakeChrome();
  let seq = 0;
  return {
    makeAdapter: () => createChromeOffscreenAdapter({ api: fake.offscreen, now: () => (seq += 1) }),
    sabotageNext: (cause) => {
      fake.hooks.sabotageOffscreenNext(cause);
    },
    sabotageCreateNext: (cause) => {
      fake.hooks.sabotageOffscreenCreateNext(cause);
    },
    sabotageCloseNext: (cause) => {
      fake.hooks.sabotageOffscreenCloseNext(cause);
    },
    killDocument: () => {
      fake.hooks.killDocument();
    },
    lastCreate: () => fake.hooks.offscreenState().lastCreate,
  };
})();

describeOffscreenPortContract('fake', binding);
