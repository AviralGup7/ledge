// E3-T01 · ADR-032 binding — WindowsPort contract suite against REFERENCE CHROME
// (env CHROME_LANE=1; skipped in node CI). See tabs-port.chrome.test.ts header.
import { describe, it } from 'vitest';
import {
  createChromeTabsAdapter,
  createChromeWindowsAdapter,
} from '@/infrastructure/chrome/index.js';
import { describeWindowsPortContract, type WindowsPortBinding } from './windows-port.contract.js';

const IN_CHROME_LANE = process.env['CHROME_LANE'] === '1' && typeof chrome !== 'undefined';

const binding = (): WindowsPortBinding => ({
  makeAdapter: () => createChromeWindowsAdapter(),
  makeTabsAdapter: () => createChromeTabsAdapter(),
  sabotageNext: null,
  openTwoWindows: async () => {
    const a = await chrome.windows.create({ url: 'about:blank', focused: false });
    const b = await chrome.windows.create({ url: 'about:blank', focused: false });
    return [a.id ?? -1, b.id ?? -1];
  },
});

(IN_CHROME_LANE ? describe : describe.skip)('chrome lane presence (windows)', () => {
  it('binds real chrome.windows', () => {
    expect(typeof chrome.windows.getAll).toBe('function');
  });
});

if (IN_CHROME_LANE) {
  describeWindowsPortContract('chrome-reference', binding());
}
