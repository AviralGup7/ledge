// E2-T07 · ADR-032 binding — StorageAreaPort contract suite against REFERENCE
// CHROME. Runs only inside browser CI lanes (CHROME_LANE=1 env with a real
// `chrome` global); Node CI skips it entirely. Sessionless + sabotage laws are
// fake-only (real Chrome exposes session and cannot be sabotaged).
import { describe, expect, it } from 'vitest';
import { createChromeStorageAreaAdapter } from '@/infrastructure/chrome/index.js';
import {
  describeStorageAreaPortContract,
  type StorageAreaPortBinding,
} from './storage-area-port.contract.js';

const IN_CHROME_LANE = process.env['CHROME_LANE'] === '1' && typeof chrome !== 'undefined';

const binding: StorageAreaPortBinding = {
  makeAdapter: () => createChromeStorageAreaAdapter(),
  makeSessionlessAdapter: null,
  sabotageStorage: null,
};

(IN_CHROME_LANE ? describe : describe.skip)('chrome lane presence', () => {
  it('binds real chrome.storage', () => {
    expect(typeof chrome.storage.local.get).toBe('function');
  });
});

if (IN_CHROME_LANE) {
  describeStorageAreaPortContract('chrome-reference', binding);
}
