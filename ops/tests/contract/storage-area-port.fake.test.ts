// E2-T07 · ADR-032 binding — StorageAreaPort contract suite against the in-memory
// fake chrome (including the sessionless Firefox-parity variant).
import { createChromeStorageAreaAdapter } from '@/infrastructure/chrome/index.js';
import { createFakeChrome } from '@/infrastructure/chrome/testing/fake-chrome.js';
import {
  describeStorageAreaPortContract,
  type StorageAreaPortBinding,
} from './storage-area-port.contract.js';

const fake = createFakeChrome();

const binding: StorageAreaPortBinding = {
  makeAdapter: () => createChromeStorageAreaAdapter({ api: fake.storage }),
  makeSessionlessAdapter: () =>
    createChromeStorageAreaAdapter({ api: { local: fake.storage.local } }),
  sabotageStorage: (cause) => {
    fake.hooks.sabotageStorageNext(cause);
  },
};

describeStorageAreaPortContract('fake-chrome', binding);
